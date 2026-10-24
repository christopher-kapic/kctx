#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { backupS3Config } from "./lib/backup-s3-env.mjs";

const dest = process.argv[2];
const keyArg = process.argv[3];
if (!dest || !keyArg) {
  console.error("FATAL: usage: download-backup-from-s3.mjs <dest-path> <s3-key>");
  process.exit(1);
}

const config = backupS3Config();
const key = keyArg.replace(/^\/+/, "");
const expectedPrefix = `${config.prefix}/`;
if (!key.startsWith(expectedPrefix) && key !== config.prefix) {
  console.error(
    `FATAL: restore key "${key}" is outside BACKUP_S3_PREFIX="${config.prefix}". Refusing to download an arbitrary object.`,
  );
  process.exit(1);
}

const client = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  forcePathStyle: config.forcePathStyle,
  credentials: config.credentials,
});

const head = await client.send(
  new HeadObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ...(process.env.RESTORE_BACKUP_S3_VERSION_ID
      ? { VersionId: process.env.RESTORE_BACKUP_S3_VERSION_ID }
      : {}),
  }),
);
const expectedETag = process.env.RESTORE_BACKUP_S3_ETAG;
if (!expectedETag || expectedETag !== head.ETag) {
  console.error(
    "FATAL: RESTORE_BACKUP_S3_ETAG must exactly match the selected source object's ETag.",
  );
  process.exit(1);
}
if (
  process.env.RESTORE_BACKUP_S3_VERSION_ID &&
  head.VersionId !== process.env.RESTORE_BACKUP_S3_VERSION_ID
) {
  console.error("FATAL: selected source object version changed before restore.");
  process.exit(1);
}

const response = await client.send(
  new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    IfMatch: expectedETag,
    ...(process.env.RESTORE_BACKUP_S3_VERSION_ID
      ? { VersionId: process.env.RESTORE_BACKUP_S3_VERSION_ID }
      : {}),
  }),
);

if (!response.Body) {
  console.error(`FATAL: s3://${config.bucket}/${key} returned an empty body.`);
  process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
await pipeline(response.Body, createWriteStream(dest));
await writeFile(
  `${dest}.identity.json`,
  JSON.stringify({
    key,
    eTag: expectedETag,
    versionId: head.VersionId ?? null,
    bucket: config.bucket,
    endpoint: config.endpoint ?? null,
    region: config.region,
  }),
  "utf8",
);
console.log(`Downloaded s3://${config.bucket}/${key} to ${dest}`);
