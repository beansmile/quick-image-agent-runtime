import { createHash } from "node:crypto";
import type { DirectUpload, InspectedAttachmentResult, PreparedAttachmentResult } from "../types.js";
import { InspectAttachmentService } from "./inspect-attachment.js";
import { PrepareAttachmentService } from "./prepare-attachment.js";
import { UploadStagedAttachmentService } from "./upload-staged-attachment.js";
import { HandleStore } from "../store/handle-store.js";

export interface AttachmentPipelinePort {
  inspect(sourceReference: string, scope?: string): Promise<InspectedAttachmentResult>;
  prepare(attachmentHandle: string, scope?: string): Promise<PreparedAttachmentResult>;
  upload(stagedHandle: string, directUpload: DirectUpload, scope?: string): Promise<{ asset_id: string }>;
  cleanupExpired(): Promise<void>;
}

export class AttachmentPipeline implements AttachmentPipelinePort {
  private constructor(
    private readonly store: HandleStore,
    private readonly inspectAttachment: InspectAttachmentService,
    private readonly prepareAttachment: PrepareAttachmentService,
    private readonly uploadAttachment: UploadStagedAttachmentService
  ) {}

  static async create(stateDirectory: string): Promise<AttachmentPipeline> {
    const store = new HandleStore(stateDirectory);
    await store.initialize();
    return new AttachmentPipeline(
      store,
      new InspectAttachmentService(store),
      new PrepareAttachmentService(store),
      new UploadStagedAttachmentService(store)
    );
  }

  inspect(sourceReference: string, scope?: string): Promise<InspectedAttachmentResult> {
    return this.inspectAttachment.execute(sourceReference, digestScope(scope));
  }

  prepare(attachmentHandle: string, scope?: string): Promise<PreparedAttachmentResult> {
    return this.prepareAttachment.execute(attachmentHandle, digestScope(scope));
  }

  upload(stagedHandle: string, directUpload: DirectUpload, scope?: string): Promise<{ asset_id: string }> {
    return this.uploadAttachment.execute(stagedHandle, directUpload, digestScope(scope));
  }

  cleanupExpired(): Promise<void> {
    return this.store.cleanupExpired();
  }
}

function digestScope(scope: string | undefined): string | undefined {
  return scope === undefined ? undefined : createHash("sha256").update(scope).digest("hex");
}
