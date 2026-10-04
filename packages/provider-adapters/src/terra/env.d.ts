// The package tsconfig (phase 2 owned) has lib ES2023 only; the Terra client uses global fetch/URL
// (Node 18+). Pull in Node's ambient types locally rather than editing the shared tsconfig.
/// <reference types="node" />
