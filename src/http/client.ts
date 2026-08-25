/** The small response surface used by network adapters and offline tests. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Optional to retain compatibility with existing JSON-only injected clients. */
  text?(): Promise<string>;
}

/** Injectable HTTP boundary.  The production default is Node's global fetch. */
export type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>;

export const defaultHttpClient: HttpClient = (url, init) => fetch(url, init);
