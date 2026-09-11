import { upsertNote, updateNote, searchNotes, listNotes } from "./notes.js";

/**
 * Per-domain tool module: the note-taking tools. Their definitions and
 * executors live here (beside the note I/O in notes.js) so the shared
 * registry in tools.js stays under the size limit and each domain owns its
 * tools. tools.js re-exports these so they appear in the single TOOLS
 * registry the LLM sees.
 */

const takeNote = {
  name: "take_note",
  label: "Take note",
  icon: "📌",
  summary: (args) => args?.title ?? "",
  definition: {
    type: "function",
    function: {
      name: "take_note",
      description:
        "Record a note in the agent's persistent notes store. A note is a " +
        "consolidation of what you currently understand about a topic — a " +
        "fact, decision, or plan — written in your own words, not a copy of " +
        "the conversation. Use this when the user asks you to remember or " +
        "take a note, or when you learn something durable that should survive " +
        "the current conversation. Notes are stored outside the repository. " +
        "A note with an existing title (case-insensitive) is updated in place " +
        "with the new content; a new title adds a note. Call recall_notes " +
        "after taking a note only if the user asks for it back.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short title for the note, describing its topic (e.g. " +
              '"Deploy target" or "User preference: dark mode").',
          },
          content: {
            type: "string",
            description:
              "The note's body: your consolidated understanding in a few " +
              "sentences, specific and self-contained so it makes sense on " +
              "its own later.",
          },
        },
        required: ["title", "content"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.title !== "string" || args.title.trim() === "") {
      return "Missing required parameter: title.";
    }
    if (typeof args?.content !== "string" || args.content.trim() === "") {
      return "Missing required parameter: content.";
    }
    try {
      const { note, updated } = await upsertNote(args.title, args.content);
      return updated
        ? `Updated note: ${note.title} (${note.content.length} characters).`
        : `Took note: ${note.title} (${note.content.length} characters).`;
    } catch (err) {
      return `Could not take note: ${err.message}`;
    }
  },
};

const updateNoteTool = {
  name: "update_note",
  label: "Update note",
  icon: "✏️",
  summary: (args) => args?.title ?? "",
  definition: {
    type: "function",
    function: {
      name: "update_note",
      description:
        "Update an existing note by replacing one exact substring of its " +
        "content with a new one. This is a precise in-place edit: every part " +
        "of the note except the given previous string is preserved. Use this " +
        "when a stored note needs a small correction or refinement rather " +
        "than a full rewrite (take_note rewrites a note in place by title; " +
        "use update_note for a targeted change). The note must already exist " +
        "— recall it first to see its exact current content. The previous " +
        "string must appear in the note's content exactly once; if it is " +
        "ambiguous or missing, nothing is changed and a reason is returned. " +
        "A previous string with an empty replacement deletes that text.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "The exact title of the note to update (matched " +
              "case-insensitively).",
          },
          old_string: {
            type: "string",
            description:
              "The exact text currently in the note to replace. Must match " +
              "character-for-character, including whitespace, and must appear " +
              "exactly once in the note's content. Include enough surrounding " +
              "context to make it unique.",
          },
          new_string: {
            type: "string",
            description:
              "The exact text to replace old_string with. An empty string " +
              "deletes old_string. Must be different from old_string.",
          },
        },
        required: ["title", "old_string", "new_string"],
      },
    },
  },
  async execute(args) {
    if (typeof args?.title !== "string" || args.title.trim() === "") {
      return "Missing required parameter: title.";
    }
    if (typeof args?.old_string !== "string") {
      return "Missing required parameter: old_string.";
    }
    if (typeof args?.new_string !== "string") {
      return "Missing required parameter: new_string.";
    }
    if (args.old_string === "") {
      return "old_string must not be empty.";
    }
    if (args.old_string === args.new_string) {
      return "new_string is identical to old_string; nothing to update.";
    }
    try {
      const { ok, note, occurrences, reason } = await updateNote(
        args.title,
        args.old_string,
        args.new_string,
      );
      if (!ok) {
        return reason;
      }
      return `Updated note: ${note.title} (${note.content.length} characters).`;
    } catch (err) {
      return `Could not update note: ${err.message}`;
    }
  },
};

const recallNotes = {
  name: "recall_notes",
  label: "Recall notes",
  icon: "🧠",
  summary: (args) => (args?.pattern ? `"${args.pattern}"` : "all"),
  definition: {
    type: "function",
    function: {
      name: "recall_notes",
      description:
        "Recall the agent's persistent notes. With no pattern, lists every " +
        "stored note. With a pattern, returns only notes whose title or " +
        "content matches the case-insensitive regex. Use this to answer " +
        "questions from what was previously noted, or to check existing notes " +
        "before taking a new one.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Optional regex matched case-insensitively against each note's " +
              'title and content (e.g. "deploy" or "^.*target$").',
          },
        },
      },
    },
  },
  async execute(args) {
    let results;
    if (args?.pattern) {
      let re;
      try {
        re = new RegExp(args.pattern, "i");
      } catch (err) {
        return `Invalid regex: ${err.message}`;
      }
      results = await searchNotes(re);
    } else {
      results = await listNotes();
    }
    const MAX_RESULTS = 50;
    const MAX_NOTE_CHARS = 500;
    const lines = results.slice(0, MAX_RESULTS).map((n) => {
      const body =
        n.content.length > MAX_NOTE_CHARS
          ? n.content.slice(0, MAX_NOTE_CHARS) + "…"
          : n.content;
      return `${n.title}\n${body}`;
    });
    if (results.length === 0) {
      return args?.pattern
        ? `No notes match /${args.pattern}/i.`
        : "No notes stored yet.";
    }
    const header =
      results.length > MAX_RESULTS
        ? `Found ${results.length} notes, showing first ${MAX_RESULTS}:\n\n`
        : `Found ${results.length} note${results.length === 1 ? "" : "s"}:\n\n`;
    return header + lines.join("\n\n");
  },
};

export { takeNote, updateNoteTool, recallNotes };
