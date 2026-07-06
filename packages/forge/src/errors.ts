import { TaggedError } from "@op/core";

export class ForgeError extends TaggedError("ForgeError")<{
  message: string;
  code: "conflict" | "not_found" | "unauthorized" | "invalid";
}>() {}
