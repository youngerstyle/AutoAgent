import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessageAttachment } from "../../shared/contracts/agent-engine.js";
import { HttpError } from "../errors.js";
import { workspaceAttachmentsDir } from "./paths.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set<AgentMessageAttachment["mimeType"]>([
  "image/png", "image/jpeg", "image/webp", "image/gif",
]);

export class AttachmentStore {
  constructor(private readonly workspaceRoot: string) {}

  async put(input: { data: Buffer; mimeType: string; fileName: string }): Promise<AgentMessageAttachment> {
    if (!IMAGE_TYPES.has(input.mimeType as AgentMessageAttachment["mimeType"])) {
      throw new HttpError(415, "只支持 PNG、JPEG、WebP 和 GIF 图片", "UNSUPPORTED_ATTACHMENT");
    }
    if (!matchesImageSignature(input.data, input.mimeType as AgentMessageAttachment["mimeType"])) {
      throw new HttpError(415, "图片内容与声明的格式不一致", "INVALID_ATTACHMENT_CONTENT");
    }
    if (input.data.length === 0 || input.data.length > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "图片大小必须在 1 字节到 10 MiB 之间", "ATTACHMENT_TOO_LARGE");
    }
    const attachmentId = createHash("sha256").update(input.data).digest("hex");
    const directory = workspaceAttachmentsDir(this.workspaceRoot);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, attachmentId);
    const metadata: AgentMessageAttachment = {
      attachmentId,
      type: "image",
      mimeType: input.mimeType as AgentMessageAttachment["mimeType"],
      fileName: sanitizeFileName(input.fileName),
      size: input.data.length,
    };
    try {
      await stat(filePath);
    } catch {
      await writeFile(filePath, input.data);
    }
    await writeFile(`${filePath}.json`, JSON.stringify(metadata), "utf8");
    return metadata;
  }

  async get(attachmentId: string): Promise<{ metadata: AgentMessageAttachment; data: Buffer }> {
    if (!/^[a-f0-9]{64}$/.test(attachmentId)) throw new HttpError(404, "附件不存在", "ATTACHMENT_NOT_FOUND");
    const filePath = path.join(workspaceAttachmentsDir(this.workspaceRoot), attachmentId);
    try {
      const [metadata, data] = await Promise.all([
        readFile(`${filePath}.json`, "utf8").then((value) => JSON.parse(value) as AgentMessageAttachment),
        readFile(filePath),
      ]);
      return { metadata, data };
    } catch {
      throw new HttpError(404, "附件不存在", "ATTACHMENT_NOT_FOUND");
    }
  }
}

function sanitizeFileName(value: string): string {
  return path.basename(value || "image").replace(/[\u0000-\u001f<>:\"/\\|?*]/g, "_").slice(0, 160) || "image";
}

function matchesImageSignature(data: Buffer, mimeType: AgentMessageAttachment["mimeType"]): boolean {
  if (mimeType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === "image/webp") return data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  return data.length >= 6 && (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a");
}
