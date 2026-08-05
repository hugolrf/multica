/**
 * Client for the daemon's local diff endpoints.
 *
 * The base URL is injected rather than derived: on desktop it points at the
 * local daemon (127.0.0.1:<healthPort>); a remote client reaches the same
 * daemon through a tunnel. Nothing here touches Node or Electron, so this
 * module is safe for both apps (see the packages/core boundary rules).
 */

import type {
  DiffFilesRequest,
  DiffFilesResponse,
  DiffOpenRequest,
  DiffParseResponse,
  DiffSourcesRequest,
  DiffSourcesResponse,
} from "./types";

export class DiffClient {
  constructor(private readonly baseUrl: string) {}

  private async post<TReq, TRes>(path: string, body: TReq, signal?: AbortSignal): Promise<TRes> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text.trim() || `HTTP ${res.status}`);
    }
    return (await res.json()) as TRes;
  }

  /** Resolve every diff source for a task family. */
  sources(req: DiffSourcesRequest, signal?: AbortSignal): Promise<DiffSourcesResponse> {
    return this.post<DiffSourcesRequest, DiffSourcesResponse>("/diff/sources", req, signal);
  }

  /** Full structured diff for one source, loaded on demand. */
  files(req: DiffFilesRequest, signal?: AbortSignal): Promise<DiffFilesResponse> {
    return this.post<DiffFilesRequest, DiffFilesResponse>("/diff/files", req, signal);
  }

  /** Open a source in a local GUI tool, on the machine holding the clones. */
  open(req: DiffOpenRequest): Promise<{ target: string }> {
    return this.post<DiffOpenRequest, { target: string }>("/diff/open", req);
  }

  /** Parse an attached `.patch` with the same parser the diff endpoints use. */
  parse(patch: string, signal?: AbortSignal): Promise<DiffParseResponse> {
    return this.post<{ patch: string }, DiffParseResponse>("/diff/parse", { patch }, signal);
  }
}

/** Ticket codes ("AGENDA-608") the daemon uses to match branches by name. */
export function extractTicketCodes(titles: string[]): string[] {
  const codes = new Set<string>();
  const re = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  for (const title of titles) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(title || ""))) {
      const code = m[1];
      if (code) codes.add(code);
    }
  }
  return [...codes];
}
