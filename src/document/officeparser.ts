import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SupportedFileType } from "officeparser";

type OfficeParserClass = typeof import("officeparser").OfficeParser;

const maximumMarkdownBytes = 8 * 1024 * 1024;
const officeTypes: Partial<Record<string, SupportedFileType>> = {
  ".csv": "csv",
  ".docx": "docx",
  ".htm": "html",
  ".html": "html",
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
};
const plainTextExtensions = new Set([".json", ".md", ".txt", ".xml", ".yaml", ".yml"]);

async function main(): Promise<number> {
  if (process.argv.length !== 3) {
    console.error("usage: officeparser <document>");
    return 2;
  }

  const source = process.argv[2]!;
  const extension = extname(source).toLowerCase();
  try {
    const bytes = await readFile(source);
    let title: string | null = null;
    let markdown: string;
    const fileType = officeTypes[extension];
    if (fileType) {
      const parser = fileType === "pdf"
        ? await textOnlyPdfParser()
        : (await import("officeparser")).OfficeParser;
      const ast = await parser.parseOffice(bytes, {
        fileType,
        extractAttachments: false,
        includeRawContent: false,
        ocr: false,
        ignoreSlideMasters: true,
        // ponytail: bounded extraction; raise only for measured large-document needs.
        decompressionLimits: {
          maxUncompressedBytes: 128 * 1024 * 1024,
          maxZipEntries: 5_000,
          maxTableCells: 200_000,
        },
      });
      title = typeof ast.metadata.title === "string"
        ? ast.metadata.title.trim().slice(0, 500) || null
        : null;
      ast.metadata = {}; // The response carries title separately; parser metadata is not document text.
      const converted = await ast.to("md", {
        generateIds: false,
        includeCharts: false,
        includeFormatting: false,
        includeImages: false,
      });
      markdown = converted.value;
    } else if (plainTextExtensions.has(extension)) {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      throw new Error(`unsupported document format: ${extension || "none"}`);
    }

    if (Buffer.byteLength(markdown, "utf8") > maximumMarkdownBytes) {
      throw new Error("converted Markdown exceeds the 8 MiB limit");
    }
    process.stdout.write(JSON.stringify({
      version: 1,
      engine: "officeparser",
      title,
      markdown,
    }));
    return 0;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n]+/gu, " ")
      .slice(0, 1_000);
    console.error(`${error instanceof Error ? error.name : "Error"}: ${message}`);
    return 1;
  }
}

async function textOnlyPdfParser(): Promise<OfficeParserClass> {
  if (!("DOMMatrix" in globalThis)) {
    // ponytail: text extraction does not render; this only satisfies PDF.js module initialization.
    Object.defineProperty(globalThis, "DOMMatrix", { value: class DOMMatrix {} });
  }
  return (await import("officeparser/slim")).OfficeParser;
}

process.exitCode = await main();
