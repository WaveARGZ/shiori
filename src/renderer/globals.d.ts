// Ambient declarations for the chrome renderer.
//
// This file deliberately has no top-level import/export, which keeps it a
// global script rather than a module — that is what lets renderer.ts reach the
// shared types through `import(...)` type queries without ever emitting a real
// import statement.
interface Window {
  shiori: import('../shared/types').ShioriApi;
}
