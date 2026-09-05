import { Data } from "effect";
// BAD: plain extends Error — catchTag cannot recover it
class StepError extends Error {
  constructor(readonly step: string) { super(`Step ${step} failed`); }
}
class ValidationError extends Error {
  constructor(readonly field: string) { super(`bad field: ${field}`); }
}
