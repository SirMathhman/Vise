// Tests must never write to the real audit log in ~/.vise.
process.env.VISE_AUDIT = "0";
// ...and must never index the folder they run in (it would call the real embedding server).
process.env.VISE_SEMANTIC_AUTOINDEX = "0";
// ...and must not ask the server what it is (an extra request would show up in every mocked `fetch`).
process.env.VISE_BACKEND_DETECT = "0";
