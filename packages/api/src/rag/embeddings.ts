export type EmbeddingSettings = {
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
};

export function isEmbeddingConfigured(settings: EmbeddingSettings): boolean {
  return !!(
    settings.embeddingBaseUrl &&
    settings.embeddingApiKey &&
    settings.embeddingModel
  );
}

export async function generateEmbeddings(
  texts: string[],
  settings: EmbeddingSettings,
): Promise<{ embeddings: Float32Array[]; dimension: number }> {
  if (!texts.length) return { embeddings: [], dimension: 0 };

  const BATCH_SIZE = 25;
  const BATCH_DELAY_MS = 500;
  const MAX_RETRIES = 5;
  const allEmbeddings: Float32Array[] = [];
  let dimension = 0;

  const url = `${settings.embeddingBaseUrl.replace(/\/+$/, "")}/embeddings`;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    let response: Response | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.embeddingApiKey}`,
        },
        body: JSON.stringify({
          input: batch,
          model: settings.embeddingModel,
        }),
      });

      if (response.status !== 429) break;

      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 2000 * (attempt + 1);
      console.warn(
        `[RAG] Rate limited, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!response!.ok) {
      const text = await response!.text();
      console.error(
        `[RAG] Embedding API error ${response!.status} from ${url}:`,
        text,
      );
      throw new Error(`Embedding API error ${response!.status}: ${text}`);
    }

    const data = (await response!.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    const sorted = data.data.sort((a, b) => a.index - b.index);

    for (const item of sorted) {
      const arr = new Float32Array(item.embedding);
      allEmbeddings.push(arr);
      if (!dimension) dimension = arr.length;
    }

    // Delay between batches to avoid rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return { embeddings: allEmbeddings, dimension };
}

export async function generateEmbedding(
  text: string,
  settings: EmbeddingSettings,
): Promise<{ embedding: Float32Array; dimension: number }> {
  const { embeddings, dimension } = await generateEmbeddings([text], settings);
  return { embedding: embeddings[0]!, dimension };
}
