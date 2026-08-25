import { type Recipe } from "../contracts/recipe.js";

/** Hand-curated catalog of defensible, multi-component composition recipes. */
export const RECIPE_CATALOG: readonly Recipe[] = [
  {
    id: "node-video-transcode",
    goal: "Transcode and process video files in Node.js",
    ecosystem: "npm",
    roles: [
      {
        role: "ffmpeg-wrapper",
        purpose: "Fluent interface to configure and execute FFmpeg transcode commands",
        required: true,
        candidateQuery: "fluent-ffmpeg",
        externalPrerequisite: "FFmpeg binary must be installed on the system PATH",
      },
      {
        role: "progress-reporter",
        purpose: "Display CLI progress indicators during video transcoding",
        required: false,
        candidateQuery: "cli-progress",
      },
    ],
    notes: ["Requires FFmpeg binary installed on the host system or container."],
  },
  {
    id: "api-input-validation",
    goal: "Validate and sanitize HTTP API request payloads with TypeScript type inference",
    ecosystem: "npm",
    roles: [
      {
        role: "schema-validator",
        purpose: "Define data schemas, validate payloads, and infer static TypeScript types",
        required: true,
        candidateQuery: "zod",
      },
      {
        role: "framework-adapter",
        purpose: "Express middleware for automatic request body, query, and params validation",
        required: true,
        candidateQuery: "zod-express-middleware",
      },
    ],
    notes: ["Combines schema parsing with Express HTTP route handling."],
  },
  {
    id: "http-resilient-client",
    goal: "Execute resilient HTTP requests with automated retry and exponential backoff",
    ecosystem: "npm",
    roles: [
      {
        role: "http-client",
        purpose: "Promise-based HTTP client for REST and API invocations",
        required: true,
        candidateQuery: "axios",
      },
      {
        role: "retry-interceptor",
        purpose: "Automatic interceptor for retrying failed network requests with exponential backoff",
        required: true,
        candidateQuery: "axios-retry",
      },
    ],
    notes: ["Attaches interceptors to Axios instances for resilient network operations."],
  },
  {
    id: "node-image-processing",
    goal: "High-performance image transformation, conversion, and metadata inspection",
    ecosystem: "npm",
    roles: [
      {
        role: "image-transformer",
        purpose: "Fast image resizing, cropping, and format conversion using libvips",
        required: true,
        candidateQuery: "sharp",
        externalPrerequisite: "libvips native binaries (prebuilt binaries provided by npm package)",
      },
      {
        role: "metadata-extractor",
        purpose: "Read and parse EXIF metadata from raw image buffers",
        required: false,
        candidateQuery: "exif-reader",
      },
    ],
    notes: ["Sharp utilizes native libvips binaries compiled for the target architecture."],
  },
  {
    id: "npm-structured-logging",
    goal: "Structured JSON logging with multi-stream log rotation",
    ecosystem: "npm",
    roles: [
      {
        role: "structured-logger",
        purpose: "Extremely fast JSON structured logger for Node.js services",
        required: true,
        candidateQuery: "pino",
      },
      {
        role: "log-rotator",
        purpose: "Daily and size-based file rotation for output log streams",
        required: false,
        candidateQuery: "rotating-file-stream",
      },
    ],
    notes: ["Pino produces NDJSON output suitable for log collectors and stream rotation."],
  },
];
