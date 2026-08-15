import {
  ComponentCandidateSchema,
  type ComponentCandidate,
} from "../contracts/index.js";
import { defaultHttpClient, type HttpClient } from "../http/client.js";
import type { Discoverer } from "../pipeline/interfaces.js";

const HUGGING_FACE_MODELS_URL = "https://huggingface.co/api/models";

export interface HuggingFaceDiscovererOptions {
  size?: number;
}

interface HuggingFaceModel {
  id?: unknown;
  likes?: unknown;
  downloads?: unknown;
  tags?: unknown;
  pipeline_tag?: unknown;
  library_name?: unknown;
  createdAt?: unknown;
  license?: unknown;
  cardData?: { license?: unknown } | null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function licenseHint(model: HuggingFaceModel, tags: string[] | undefined): string | undefined {
  const direct = stringValue(model.license) ?? stringValue(model.cardData?.license);
  if (direct) return direct;

  return tags?.find((tag) => tag.startsWith("license:"))?.slice("license:".length) || undefined;
}

function descriptionFor(model: HuggingFaceModel, tags: string[] | undefined): string {
  const pipeline = stringValue(model.pipeline_tag);
  const library = stringValue(model.library_name);
  const tag = tags?.find((value) => !value.includes(":"));
  const kind = pipeline ?? tag ?? "Hugging Face";
  return `${kind} model${library ? ` (${library})` : ""}`;
}

function candidateFromModel(model: HuggingFaceModel): ComponentCandidate | undefined {
  const id = stringValue(model.id);
  if (!id) return undefined;

  const tags = stringArray(model.tags);
  try {
    return ComponentCandidateSchema.parse({
      id: `huggingface:${id}`,
      name: id,
      ecosystem: "huggingface",
      description: descriptionFor(model, tags),
      repoUrl: `https://huggingface.co/${id}`,
      keywords: tags,
      license: licenseHint(model, tags),
      stars: nonnegativeNumber(model.likes),
      downloads: nonnegativeNumber(model.downloads),
      publishedAt: stringValue(model.createdAt),
    });
  } catch {
    return undefined;
  }
}

/** Discovers model repositories through Hugging Face's public models API. */
export class HuggingFaceDiscoverer implements Discoverer {
  private readonly cache = new Map<string, Promise<ComponentCandidate[]>>();
  private readonly size: number;

  constructor(
    private readonly http: HttpClient = defaultHttpClient,
    options: HuggingFaceDiscovererOptions = {},
  ) {
    this.size = options.size ?? 20;
  }

  discover(query: string): Promise<ComponentCandidate[]> {
    const cached = this.cache.get(query);
    if (cached) return cached;

    const discovery = this.fetchCandidates(query);
    this.cache.set(query, discovery);
    return discovery;
  }

  private async fetchCandidates(query: string): Promise<ComponentCandidate[]> {
    const url = new URL(HUGGING_FACE_MODELS_URL);
    url.searchParams.set("search", query);
    url.searchParams.set("sort", "downloads");
    url.searchParams.set("direction", "-1");
    url.searchParams.set("limit", String(this.size));

    try {
      const response = await this.http(url.toString());
      if (!response.ok) return [];

      const payload = await response.json() as unknown;
      return Array.isArray(payload)
        ? payload.flatMap((item) => {
          const candidate = item && typeof item === "object"
            ? candidateFromModel(item as HuggingFaceModel)
            : undefined;
          return candidate ? [candidate] : [];
        })
        : [];
    } catch {
      return [];
    }
  }
}
