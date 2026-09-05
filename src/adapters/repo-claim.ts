/**
 * A package's repository URL is self-declared metadata. Nothing stops a package from
 * naming someone else's repository — and typosquats do exactly that.
 *
 * Found by searching PyPI for "http requests": `definitely-not-requests`,
 * `degree72-requests`, `odigos-requests` and `requeste` all declare
 * `github.com/psf/requests` as their source, and all copy its summary verbatim
 * ("Python HTTP for Humans."). ossfind fetched psf/requests' OpenSSF Scorecard for
 * each of them and reported SHIP 92/100 on health evidence belonging to a project
 * they have nothing to do with.
 *
 * So a repository's evidence is attributed to a package only when the claim is
 * corroborated by the names themselves. This cannot be exact — legitimate packages
 * live in monorepos and in repos named differently — so it is deliberately tolerant,
 * and it fails CLOSED: an uncorroborated claim withholds the health evidence, which
 * the ranker already treats as "unverified" and caps at caution. Capping a legitimate
 * package is a usability cost; granting an impostor a ship verdict is a safety failure.
 */

/** Suffixes projects add to a repo name that the package name omits, and vice versa. */
const LANGUAGE_SUFFIXES = [".js", "-js", ".ts", "-ts", ".py", "-py", "-python", ".rs", "-rs", "-rust", "-ruby", ".rb", "-node", ".git"];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_.]/g, "-").replace(/^-+|-+$/g, "");
}

/** Prefixes a repo adds that the published package name omits: auth0/node-jsonwebtoken. */
const LANGUAGE_PREFIXES = ["node-", "python-", "py-", "rust-", "ruby-", "go-", "js-"];

function withoutLanguageAffix(value: string): string {
  let result = value;
  for (const suffix of LANGUAGE_SUFFIXES) {
    const normalized = normalize(suffix);
    if (result.length > normalized.length && result.endsWith(normalized)) {
      result = result.slice(0, -normalized.length).replace(/-+$/, "");
      break;
    }
  }
  for (const prefix of LANGUAGE_PREFIXES) {
    if (result.length > prefix.length && result.startsWith(prefix)) {
      return result.slice(prefix.length);
    }
  }
  return result;
}

export interface RepositoryIdentity {
  owner: string;
  name: string;
}

/** Parse `owner/name` out of a repository URL. Non-GitHub hosts return undefined. */
export function repositoryIdentity(repoUrl: string | undefined): RepositoryIdentity | undefined {
  if (!repoUrl) return undefined;
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    if (!owner || !name) return undefined;
    return { owner: normalize(owner), name: normalize(name.replace(/\.git$/i, "")) };
  } catch {
    return undefined;
  }
}

/**
 * Split an ecosystem package name into the parts that may correspond to a repository.
 * npm scopes are returned separately: `@babel/core` lives in `babel/babel`.
 */
function packageParts(packageName: string): { scope?: string; base: string } {
  const scoped = /^@([^/]+)\/(.+)$/.exec(packageName.trim());
  return scoped
    ? { scope: normalize(scoped[1]), base: normalize(scoped[2]) }
    : { base: normalize(packageName) };
}

/**
 * Whether `repoUrl` plausibly belongs to `packageName`.
 *
 * Corroborated when the repository name matches the package name (allowing a language
 * suffix on either side), or when the repository OWNER accounts for the package — an
 * organisation publishing many packages from one repo, like `lodash/lodash` publishing
 * `lodash.clonedeep`, or the npm scope matching the org.
 *
 * Deliberately NOT corroborated by the package name merely *containing* the repository
 * name: that is the impostor's own trick (`definitely-not-requests` contains `requests`).
 */
export function repositoryClaimCorroborated(packageName: string, repoUrl: string | undefined): boolean {
  const repository = repositoryIdentity(repoUrl);
  if (!repository) return false;

  const { scope, base } = packageParts(packageName);
  if (!base) return false;

  const repoName = withoutLanguageAffix(repository.name);
  const packageBase = withoutLanguageAffix(base);

  // The repo is named for the package (requests ↔ psf/requests, marked ↔ markedjs/marked).
  if (repoName === packageBase || repository.name === base) return true;

  // The org is named for the package, or vice versa (axios ↔ axios/axios).
  if (repository.owner === packageBase || repository.owner === base) return true;

  // An npm scope matching the org (@babel/core ↔ babel/babel, @aws-sdk/* ↔ aws/…).
  if (scope && (scope === repository.owner || withoutLanguageAffix(scope) === repository.owner)) return true;

  // A monorepo publishing prefixed packages (lodash/lodash → lodash.clonedeep,
  // requests/toolbelt → requests-toolbelt). The OWNER must be the prefix: allowing the
  // repo NAME to be the prefix would corroborate `requests-anything` → `psf/requests`.
  if (base.startsWith(`${repository.owner}-`)) return true;

  return false;
}
