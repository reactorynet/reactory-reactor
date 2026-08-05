import { parseMarkdown, extractTags, stripInlineMarkup } from "./MarkdownParser";
import { slugify } from "./DocumentTypes";

describe("slugify", () => {
  it("produces GitHub-compatible anchors", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
    expect(slugify("What's New?")).toBe("whats-new");
    expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
    expect(slugify("C# & .NET")).toBe("c-net");
    expect(slugify("snake_case_kept")).toBe("snake_case_kept");
  });

  it("keeps non-latin scripts addressable", () => {
    expect(slugify("Überblick")).toBe("überblick");
    expect(slugify("概要")).toBe("概要");
  });
});

describe("parseMarkdown - headings", () => {
  it("extracts ATX headings with levels and line numbers", () => {
    const outline = parseMarkdown("# Title\n\nIntro.\n\n## Setup\n\n### Prerequisites\n");
    expect(outline.sections.map((s) => [s.title, s.level, s.line])).toEqual([
      ["Title", 1, 1],
      ["Setup", 2, 5],
      ["Prerequisites", 3, 7],
    ]);
  });

  it("nests sections by heading level", () => {
    const outline = parseMarkdown("# A\n## B\n### C\n## D\n# E\n");
    const byTitle = new Map(outline.sections.map((s, i) => [s.title, { s, i }]));
    expect(byTitle.get("A")!.s.parentIndex).toBeUndefined();
    expect(byTitle.get("B")!.s.parentIndex).toBe(byTitle.get("A")!.i);
    expect(byTitle.get("C")!.s.parentIndex).toBe(byTitle.get("B")!.i);
    // D closes C and re-parents to A, not B.
    expect(byTitle.get("D")!.s.parentIndex).toBe(byTitle.get("A")!.i);
    expect(byTitle.get("E")!.s.parentIndex).toBeUndefined();
  });

  it("tracks each section's line range, including its subsections", () => {
    // A spans to the end of the document because B nests inside it; a section
    // only ends where a heading of the same or shallower level begins.
    const outline = parseMarkdown("# A\nline\n## B\nline\n# C\nline\n");
    const [a, b, c] = outline.sections;
    expect([a.line, a.endLine]).toEqual([1, 4]); // ends before "# C"
    expect([b.line, b.endLine]).toEqual([3, 4]);
    expect(c.line).toBe(5);
    expect(c.endLine).toBeGreaterThanOrEqual(6);
  });

  it("ignores headings inside fenced code blocks", () => {
    const outline = parseMarkdown(
      "# Real\n\n```sh\n# not a heading\necho hi\n```\n\n## Also Real\n"
    );
    expect(outline.sections.map((s) => s.title)).toEqual(["Real", "Also Real"]);
    expect(outline.codeBlocks).toHaveLength(1);
    expect(outline.codeBlocks[0].language).toBe("sh");
    expect(outline.codeBlocks[0].content).toContain("echo hi");
  });

  it("handles tilde fences and nested backticks", () => {
    const outline = parseMarkdown("~~~md\n# inner\n```\nstill code\n```\n~~~\n# Outer\n");
    expect(outline.sections.map((s) => s.title)).toEqual(["Outer"]);
    expect(outline.codeBlocks).toHaveLength(1);
  });

  it("does not treat #hashtag as a heading", () => {
    const outline = parseMarkdown("Filed under #documentation today\n");
    expect(outline.sections).toHaveLength(0);
  });

  it("reads setext headings", () => {
    const outline = parseMarkdown("Title Here\n==========\n\nBody\n\nSub\n---\n");
    expect(outline.sections.map((s) => [s.title, s.level, s.line])).toEqual([
      ["Title Here", 1, 1],
      ["Sub", 2, 6],
    ]);
  });

  it("does not mistake a table delimiter or list dash for a setext underline", () => {
    const table = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(table.sections).toHaveLength(0);
    expect(table.metrics.tables).toBe(1);

    const list = parseMarkdown("- an item\n---\n");
    expect(list.sections).toHaveLength(0);
  });

  it("de-duplicates repeated heading slugs the way GitHub does", () => {
    const outline = parseMarkdown("## Overview\n## Overview\n## Overview\n");
    expect(outline.sections.map((s) => s.slug)).toEqual([
      "overview",
      "overview-1",
      "overview-2",
    ]);
  });

  it("honours an explicit {#custom-id}", () => {
    const outline = parseMarkdown("## Installing the CLI {#install}\n");
    expect(outline.sections[0].slug).toBe("install");
    expect(outline.sections[0].title).toBe("Installing the CLI");
  });

  it("records <a name> anchors as section aliases", () => {
    const outline = parseMarkdown('## Setup\n\n<a name="legacy-setup"></a>\n\nBody\n');
    expect(outline.sections[0].aliases).toContain("legacy-setup");
  });

  it("strips inline markup from heading text", () => {
    const outline = parseMarkdown("## The **bold** `code` [link](x.md) heading\n");
    expect(outline.sections[0].title).toBe("The bold code link heading");
  });

  it("closes an unterminated fence and warns", () => {
    const outline = parseMarkdown("# A\n\n```\nunclosed\n");
    expect(outline.warnings.join(" ")).toMatch(/Unterminated code fence/);
    expect(outline.codeBlocks).toHaveLength(1);
  });
});

describe("parseMarkdown - frontmatter", () => {
  it("parses YAML frontmatter without shifting line numbers", () => {
    const outline = parseMarkdown(
      "---\ntitle: My Doc\ntags:\n  - auth\n  - security\nowner: platform\n---\n\n# Heading\n"
    );
    expect(outline.frontmatter).toEqual({
      title: "My Doc",
      tags: ["auth", "security"],
      owner: "platform",
    });
    expect(outline.title).toBe("My Doc");
    expect(outline.tags).toEqual(["auth", "security"]);
    // "# Heading" is on line 9 of the original file.
    expect(outline.sections[0].line).toBe(9);
  });

  it("falls back to the first h1 for the title", () => {
    expect(parseMarkdown("## Second\n# First\n").title).toBe("First");
    expect(parseMarkdown("## Only\n").title).toBe("Only");
  });

  it("survives malformed frontmatter", () => {
    const outline = parseMarkdown("---\ntitle: [unclosed\n---\n\n# Body\n");
    expect(outline.warnings.length).toBeGreaterThan(0);
    expect(outline.sections.map((s) => s.title)).toEqual(["Body"]);
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    const outline = parseMarkdown("# A\n\n---\n\n# B\n");
    expect(outline.frontmatter).toBeUndefined();
    expect(outline.sections.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("leaves an unterminated frontmatter block as body", () => {
    const outline = parseMarkdown("---\ntitle: X\n\n# Heading\n");
    expect(outline.frontmatter).toBeUndefined();
    expect(outline.sections.map((s) => s.title)).toEqual(["Heading"]);
  });
});

describe("extractTags", () => {
  it("normalises list and string forms across fields", () => {
    expect(extractTags({ tags: ["a", "b"], keywords: "c, d" })).toEqual(["a", "b", "c", "d"]);
  });

  it("de-duplicates case-insensitively and skips non-scalars", () => {
    expect(extractTags({ tags: ["Auth", "auth"], topics: [{ nested: 1 }] })).toEqual(["Auth"]);
  });

  it("returns an empty list when there is no frontmatter", () => {
    expect(extractTags(undefined)).toEqual([]);
  });
});

describe("parseMarkdown - links", () => {
  it("extracts inline links, images and their line numbers", () => {
    const outline = parseMarkdown(
      "# T\n\nSee [the guide](./docs/guide.md) and ![diagram](./img/arch.png).\n"
    );
    const link = outline.links.find((l) => l.kind === "link")!;
    expect(link).toMatchObject({ label: "the guide", href: "./docs/guide.md", line: 3 });
    const image = outline.links.find((l) => l.kind === "image")!;
    expect(image).toMatchObject({ label: "diagram", href: "./img/arch.png" });
    expect(outline.metrics.images).toBe(1);
  });

  it("attributes each link to its containing section", () => {
    const outline = parseMarkdown("# A\n[one](a.md)\n\n## B\n[two](b.md)\n");
    const one = outline.links.find((l) => l.href === "a.md")!;
    const two = outline.links.find((l) => l.href === "b.md")!;
    expect(outline.sections[one.sectionIndex!].title).toBe("A");
    expect(outline.sections[two.sectionIndex!].title).toBe("B");
  });

  it("ignores links inside code spans and code fences", () => {
    const outline = parseMarkdown(
      "Use `[label](not-a-link.md)` here.\n\n```\n[also](nope.md)\n```\n"
    );
    expect(outline.links.filter((l) => l.kind === "link")).toHaveLength(0);
  });

  it("strips link titles from destinations", () => {
    const outline = parseMarkdown('[x](./a.md "The title")\n');
    expect(outline.links[0].href).toBe("./a.md");
  });

  it("handles an image nested inside a link", () => {
    const outline = parseMarkdown("[![badge](./b.svg)](https://ci.example.com)\n");
    const hrefs = outline.links.map((l) => l.href);
    expect(hrefs).toContain("https://ci.example.com");
  });

  it("resolves reference-style links defined later in the file", () => {
    const outline = parseMarkdown(
      "See [the spec][spec] and [guide][].\n\n[spec]: ./spec.md\n[guide]: ./guide.md\n"
    );
    const hrefs = outline.links.map((l) => l.href);
    expect(hrefs).toContain("./spec.md");
    expect(hrefs).toContain("./guide.md");
  });

  it("drops shortcut references with no definition", () => {
    const outline = parseMarkdown("A [bracketed phrase] in prose.\n");
    expect(outline.links).toHaveLength(0);
  });

  it("extracts autolinks and bare URLs once each", () => {
    const outline = parseMarkdown("<https://a.example.com> and https://b.example.com/x.\n");
    const hrefs = outline.links.map((l) => l.href);
    expect(hrefs).toContain("https://a.example.com");
    // trailing sentence punctuation is not part of the URL
    expect(hrefs).toContain("https://b.example.com/x");
    expect(outline.metrics.externalLinks).toBe(2);
  });

  it("extracts path-like code spans as references", () => {
    const outline = parseMarkdown(
      "Configured in `src/config/index.ts`, not in `someVariable` or `npm run build`.\n"
    );
    const spans = outline.links.filter((l) => l.kind === "code-span");
    expect(spans.map((s) => s.href)).toEqual(["src/config/index.ts"]);
  });

  it("ignores bare filenames in code spans, which prose mentions generically", () => {
    // "the `package.json` file" is a statement about a convention, not a
    // reference to one specific file - a directory separator is required.
    const outline = parseMarkdown("Detected via `package.json`, see also `README.md`.\n");
    expect(outline.links.filter((l) => l.kind === "code-span")).toHaveLength(0);
  });

  it("skips content inside HTML comments", () => {
    const outline = parseMarkdown("# A\n\n<!--\n## Commented\n[x](y.md)\n-->\n\n## Real\n");
    expect(outline.sections.map((s) => s.title)).toEqual(["A", "Real"]);
    expect(outline.links).toHaveLength(0);
  });
});

describe("parseMarkdown - metrics and tasks", () => {
  it("counts tasks, tables, code blocks and reading time", () => {
    const outline = parseMarkdown(
      [
        "# Plan",
        "",
        "- [x] done thing",
        "- [ ] pending thing",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n")
    );
    expect(outline.metrics.tasks).toBe(2);
    expect(outline.metrics.tasksDone).toBe(1);
    expect(outline.metrics.tables).toBe(1);
    expect(outline.metrics.codeBlocks).toBe(1);
    expect(outline.metrics.sections).toBe(1);
    expect(outline.tasks[0]).toMatchObject({ text: "done thing", done: true, line: 3 });
  });

  it("reports a reading time for prose and none for an empty document", () => {
    const words = new Array(400).fill("word").join(" ");
    expect(parseMarkdown(words).metrics.readingMinutes).toBe(2);
    expect(parseMarkdown("").metrics.readingMinutes).toBe(0);
  });

  it("handles an empty document without throwing", () => {
    const outline = parseMarkdown("");
    expect(outline.sections).toHaveLength(0);
    expect(outline.links).toHaveLength(0);
    expect(outline.title).toBeUndefined();
  });
});

describe("stripInlineMarkup", () => {
  it("removes emphasis, code, links and html", () => {
    expect(stripInlineMarkup("**bold** _em_ `code` [t](u) <br/> ~~gone~~")).toBe(
      "bold em code t  gone"
    );
  });
});
