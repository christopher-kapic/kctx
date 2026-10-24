/** Own one direct native client through timeout/cancellation and final close. */
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, readSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function boundedChild(
  file,
  args,
  { env = process.env, cwd, signal, timeout = 0, stdio = "inherit", cooperative = false } = {},
) {
  if (signal?.aborted) throw new Error("Client cancelled before start.");
  const child = spawn(file, args, { env, cwd, stdio });
  let stopped = false;
  let failed = false;
  let escalation;
  const stop = () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    child.kill("SIGTERM");
    // Node owns the native process handle and observes exit before another JS
    // callback can signal it. A shell's saved $! does not have that property.
    // Known nested owners must finish their own leaf drain and EXIT cleanup;
    // forcing them down would orphan that leaf. Only native leaves escalate.
    if (!cooperative)
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
  };
  signal?.addEventListener("abort", stop, { once: true });
  const deadline = timeout ? setTimeout(stop, timeout) : undefined;
  const done = new Promise((resolve, reject) => {
    // An error can also mean a failed signal while the process is still alive.
    // Only close is evidence that this owner may acknowledge its final drain.
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", stop);
      if (failed || stopped || code !== 0)
        reject(new Error("Client failed, timed out, or was cancelled."));
      else resolve();
    });
  });
  return { child, done, stop };
}

// A nonblocking read binds cancellation to this opened FIFO, including parent
// death/EOF. Read once before spawn so cancellation during publication admits
// no command. Polling the descriptor avoids a blocking thread-pool FIFO read
// preventing supervisor exit; nothing polls a PID or reopens the pathname.
export function childControl(channel, descriptor, abort) {
  let fd;
  try {
    fd = openSync(channel, constants.O_RDONLY | constants.O_NONBLOCK);
  } finally {
    closeSync(descriptor);
  }
  const byte = Buffer.alloc(1);
  const check = () => {
    try {
      // Any byte or EOF closes admission. EAGAIN alone means a live parent
      // still owns the write peer and has not requested cancellation.
      readSync(fd, byte, 0, 1, null);
      abort.abort();
    } catch (error) {
      if (error.code !== "EAGAIN") abort.abort();
    }
  };
  check();
  const poll = setInterval(check, 25);
  return () => {
    clearInterval(poll);
    closeSync(fd);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => abort.abort());
  let closeControl;
  let channel;
  let owner;
  let cooperative = false;
  try {
    let offset = 2;
    if (process.argv[offset] === "--control") {
      channel = process.argv[offset + 1];
      const descriptor = Number(process.argv[offset + 2]);
      if (!channel || ![6, 7, 8, 9].includes(descriptor)) throw new Error("Invalid child channel.");
      closeControl = childControl(channel, descriptor, abort);
      offset += 3;
    }
    if (process.argv[offset] === "--cooperative") {
      cooperative = true;
      offset++;
    }
    const timeout = Number(process.argv[offset++]);
    const forwardInput = process.argv[offset] === "--close-input";
    if (forwardInput) offset++;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || !process.argv[offset])
      throw new Error("Invalid client deadline.");
    owner = boundedChild(process.argv[offset], process.argv.slice(offset + 1), {
      signal: abort.signal,
      timeout,
      cooperative,
      stdio: forwardInput ? ["pipe", "inherit", "inherit"] : "inherit",
    });
    let inputDeadline;
    if (forwardInput) {
      owner.child.stdin.on("error", () => {});
      process.stdin.pipe(owner.child.stdin);
      process.stdin.once("end", () => {
        inputDeadline = setTimeout(owner.stop, 5_000);
      });
    }
    try {
      await owner.done;
    } finally {
      clearTimeout(inputDeadline);
      if (forwardInput) {
        process.stdin.unpipe(owner.child.stdin);
        process.stdin.destroy();
      }
    }
  } catch {
    console.error(
      "FATAL: database/preparation client failed or was cancelled; no success is implied.",
    );
    process.exitCode = channel && owner?.child.exitCode ? owner.child.exitCode : 1;
  } finally {
    closeControl?.();
    // Native close proves the direct client stopped. Cooperative owners use
    // exit 125 to propagate missing nested acknowledgement; a fatal signal or
    // a killed supervisor cannot attest that a descendant has drained.
    if (
      channel &&
      (!owner || !cooperative || (owner.child.signalCode === null && owner.child.exitCode !== 125))
    ) {
      writeFileSync(`${channel}.drained`, "drained\n", { flag: "wx", mode: 0o600 });
    }
  }
}
