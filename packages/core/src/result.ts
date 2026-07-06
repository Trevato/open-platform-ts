// The one place better-result is imported. Everything else imports from @op/core.
export {
  Result,
  TaggedError,
  Ok,
  Err,
  Panic,
  isPanic,
  isTaggedError,
  matchError,
  matchErrorPartial,
  panic,
} from "better-result";
export type {
  InferErr,
  InferOk,
  TaggedErrorClass,
  TaggedErrorInstance,
} from "better-result";
