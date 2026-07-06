import { TaggedError } from "@op/core";

export class GateError extends TaggedError("GateError")<{
  message: string;
}>() {}
