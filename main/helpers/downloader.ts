import fs from 'fs';
import path from 'path';

export async function download(
  sourceUrl: string,
  targetFile: string,
  progressCallback: ((bytes: number, percent: number | null) => void) | null,
  length?: number,
) {
  // Ensure destination directory exists to avoid open errors
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });

  const request = new Request(sourceUrl, {
    headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
  });

  const response = await fetch(request);
  if (!response.ok) {
    throw Error(`Unable to download, server returned ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (body == null) {
    throw Error('No response body');
  }

  const finalLength = length || parseInt(response.headers.get('Content-Length') || '0', 10);
  const reader = body.getReader();
  const writer = fs.createWriteStream(targetFile);

  try {
    await streamWithProgress(finalLength, reader, writer, progressCallback);
  } catch (err) {
    // Clean up partial file on failure
    try {
      writer.destroy();
    } catch {}
    try {
      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    } catch {}
    throw err;
  }

  writer.end();
}

async function streamWithProgress(
  length: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: fs.WriteStream,
  progressCallback: ((bytes: number, percent: number | null) => void) | null,
) {
  let bytesDone = 0;
  let writerError: Error | null = null;

  writer.on('error', (err) => {
    writerError = err;
  });

  while (true) {
    const result = await reader.read();
    if (result.done) {
      if (progressCallback != null) {
        progressCallback(length, 100);
      }
      return;
    }

    const chunk = result.value;
    if (chunk == null) {
      throw Error('Empty chunk received during download');
    } else {
      writer.write(Buffer.from(chunk));
      if (writerError) {
        throw writerError;
      }
      if (progressCallback != null) {
        bytesDone += chunk.byteLength;
        const percent = length === 0 ? null : Math.floor((bytesDone / length) * 100);
        progressCallback(bytesDone, percent);
      }
    }
  }
}
