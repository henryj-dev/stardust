/**
 * The Kubernetes API, as plugins see it: plain requests, and streamed GETs
 * such as a followed pod log. The composition root provides the in-cluster
 * client (`@stardust/kube`); tests provide fakes.
 */

export interface KubeResponse {
  status: number;
  body: string;
}

export interface KubeClient {
  request(method: string, path: string, body?: unknown): Promise<KubeResponse>;
}

/** A GET whose body is read as it arrives, such as a followed pod log. */
export interface KubeStreamResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

export interface KubeStreamClient extends KubeClient {
  /** Aborting the signal ends the request and the body. */
  stream(path: string, signal: AbortSignal): Promise<KubeStreamResponse>;
}
