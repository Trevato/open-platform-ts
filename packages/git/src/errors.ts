import { TaggedError } from "@op/core";

export class GitError extends TaggedError("GitError")<{
  message: string;
  op: string;
}>() {}
