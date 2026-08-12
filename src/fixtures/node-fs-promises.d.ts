declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isFile(): boolean;
  }

  export function readFile(path: string, encoding: "utf8"): Promise<string>;

  export function readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]>;
}
