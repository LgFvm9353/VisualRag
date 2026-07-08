declare module "mammoth" {
  interface MammothMessage {
    type: string;
    message: string;
    error?: Error;
  }

  interface MammothResult<T = string> {
    value: T;
    messages: MammothMessage[];
  }

  interface MammothInput {
    path?: string;
    buffer?: Buffer;
  }

  interface MammothOptions {
    styleMap?: string | string[];
    transformDocument?: (document: unknown) => unknown;
    outputFormat?: "html" | "markdown";
  }

  export function extractRawText(
    input: MammothInput,
  ): Promise<MammothResult<string>>;

  export function convertToHtml(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult<string>>;

  export function convertToMarkdown(
    input: MammothInput,
    options?: MammothOptions,
  ): Promise<MammothResult<string>>;
}
