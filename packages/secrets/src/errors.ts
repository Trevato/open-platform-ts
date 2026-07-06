import { TaggedError } from "@op/core";

export class KeyFileError extends TaggedError("KeyFileError")<{
  message: string;
  path: string;
}>() {}

export class SealError extends TaggedError("SealError")<{
  message: string;
  secret: string;
}>() {}

export class UnsealError extends TaggedError("UnsealError")<{
  message: string;
  secret: string;
}>() {}

export class SovereigntyViolation extends TaggedError("SovereigntyViolation")<{
  message: string;
  secret: string;
}>() {}
