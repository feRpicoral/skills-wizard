import { SourceError } from './errors.ts';

export interface ReadBoundedResponseTextParams {
  response: Response;
  maxBytes: number;
  exceededMessage: string;
}

/**
 * Reads a fetch {@link Response} body as a UTF-8 string while enforcing an
 * upper bound of `maxBytes`, checking `Content-Length` up front and streaming
 * chunks via `for await (const chunk of response.body)`.
 *
 * @throws {SourceError} When `Content-Length` or total received bytes exceed `maxBytes`.
 */
export async function readBoundedResponseText({
  response,
  maxBytes,
  exceededMessage,
}: ReadBoundedResponseTextParams): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength =
    contentLengthHeader !== null ? Number(contentLengthHeader) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new SourceError(exceededMessage);
  }
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new SourceError(exceededMessage);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new SourceError(exceededMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
