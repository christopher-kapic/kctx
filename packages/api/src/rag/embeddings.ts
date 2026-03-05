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

  const BATCH_SIZE = 100;
  const allEmbeddings: Float32Array[] = [];
  let dimension = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const url = `${settings.embeddingBaseUrl.replace(/\/+$/, "")}/embeddings`;
    const response = await fetch(url, {
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

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[RAG] Embedding API error ${response.status} from ${url}:`,
        text,
      );
      throw new Error(`Embedding API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    const sorted = data.data.sort((a, b) => a.index - b.index);

    for (const item of sorted) {
      const arr = new Float32Array(item.embedding);
      allEmbeddings.push(arr);
      if (!dimension) dimension = arr.length;
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 100));
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
