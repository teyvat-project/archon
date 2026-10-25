import { header, json, parseCookies, type Received, type Route } from '../http.js';

/** The `Echo` schema of edge-cases.yaml. */
export interface Echo {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  contentType?: string;
  body?: string;
  files?: { field: string; name: string; size: number }[];
}

interface Part {
  name: string;
  filename?: string;
  data: Buffer;
}

function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/** Minimal multipart/form-data parser: enough for what fetch's FormData encoder produces. */
function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const afterDelimiter = pos + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--') break;
    const start = afterDelimiter + 2; // CRLF
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start, next - 2); // CRLF before the next delimiter
    const headerEnd = part.indexOf('\r\n\r\n');
    const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
    const disposition = rawHeaders.split('\r\n').find((line) => /^content-disposition:/i.test(line)) ?? '';
    const name = /\bname="([^"]*)"/.exec(disposition)?.[1] ?? '';
    const filename = /\bfilename="([^"]*)"/.exec(disposition)?.[1];
    parts.push({ name, ...(filename !== undefined && { filename }), data: part.subarray(headerEnd + 4) });
    pos = next;
  }
  return parts;
}

/** Describes the request; multipart text fields become a JSON object in `body`, file parts go to `files`. */
export function echo(req: Received): Echo {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(req.headers)) headers[name] = header(req, name) ?? '';

  const result: Echo = { method: req.method, path: req.path, query: req.query, headers, cookies: parseCookies(req) };
  const contentType = header(req, 'content-type');
  if (contentType !== undefined) result.contentType = contentType;

  const boundary = contentType?.startsWith('multipart/') ? boundaryOf(contentType) : undefined;
  if (boundary !== undefined) {
    const fields: Record<string, string | string[]> = {};
    const files: NonNullable<Echo['files']> = [];
    for (const part of parseMultipart(req.body, boundary)) {
      if (part.filename !== undefined) {
        files.push({ field: part.name, name: part.filename, size: part.data.length });
        continue;
      }
      const value = part.data.toString('utf8');
      const existing = fields[part.name];
      fields[part.name] = existing === undefined ? value : [existing, value].flat();
    }
    result.body = JSON.stringify(fields);
    result.files = files;
  } else if (req.body.length > 0) {
    result.body = req.body.toString('utf8');
  }
  return result;
}

export const echoRoutes: Route[] = [{ method: '*', path: /^\/echo\//, handle: (req) => json(200, echo(req)) }];
