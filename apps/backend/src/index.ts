import { createApp, createContext } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const rootPath =
  process.env.ROOT_DIR ?? "C:\\Users\\mathm\\Documents\\Projects\\Vise";
const app = createApp(createContext(rootPath));

void app.listen(port).then(() => {
  // eslint-disable-next-line no-console
  console.log(`[vise/backend] listening on http://localhost:${port}`);
});
