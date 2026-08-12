export interface Result {
  status: "pass" | "fail" | "detected" | "undetected" | "not_implemented";
  message?: string;
}

export interface Gate {
  id: string;
  description: string;
  check(): Promise<Result>;
  proveFailure(): Promise<Result>;
}
