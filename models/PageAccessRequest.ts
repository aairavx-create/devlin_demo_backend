import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const PageAccessRequestSchema = new Schema(
  {
    pageId: { type: String, required: true, index: true },
    pageName: String,
    mainAccountId: { type: Schema.Types.ObjectId, ref: 'MainAccount' },
    businessId: { type: String, required: true },
    permittedTasks: [String],
    status: { type: String, enum: ['pending', 'approved', 'failed'], default: 'pending', index: true },
    metaAccessStatus: String,
    error: String,
    note: String,
    resolvedAt: Date,
  },
  { timestamps: true },
);

export type PageAccessRequestDoc = InferSchemaType<typeof PageAccessRequestSchema>;
export const PageAccessRequest: Model<PageAccessRequestDoc> =
  (models.PageAccessRequest as Model<PageAccessRequestDoc>) ||
  model<PageAccessRequestDoc>('PageAccessRequest', PageAccessRequestSchema);
