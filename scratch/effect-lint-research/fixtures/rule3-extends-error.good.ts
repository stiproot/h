import { Data } from "effect";
// GOOD: Data.TaggedError gives catchTag a discriminant
class StepError extends Data.TaggedError("StepError")<{ readonly step: string }> {}
class ValidationError extends Data.TaggedError("ValidationError")<{ readonly field: string }> {}
// GOOD: extending a non-Error base is fine
class MyStream extends ReadableStream {}
