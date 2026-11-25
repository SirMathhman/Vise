// Code shared by the frontend and the backend: types and pure helpers only.

export interface HealthResponse {
  status: "ok";
  service: string;
  time: string;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
