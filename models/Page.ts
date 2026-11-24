import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const PageSchema = new Schema(
  {
    pageId: { type: String, required: true, unique: true },
    mainAccountId: { type: Schema.Types.ObjectId, ref: 'MainAccount', index: true },
    name: String,
    category: String,
    pictureUrl: String,
    link: String,
    fanCount: Number,
    // personal = you manage it directly, owned = owned by the business, client = shared with the business by another owner
    relationship: { type: String, enum: ['personal', 'owned', 'client'], default: 'personal' },
    tasks: [String],
    instagram: {
      id: String,
      username: String,
      pictureUrl: String,
    },
    // Page access token, AES-256-GCM encrypted. Never returned by default.
    accessTokenEnc: { type: String, select: false },
    hasToken: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    leadgenSubscribed: { type: Boolean, default: false },
    leadsSyncedAt: Date,
    lastSyncedAt: Date,
  },
  { timestamps: true },
);

export type PageDoc = InferSchemaType<typeof PageSchema>;
export const Page: Model<PageDoc> = (models.Page as Model<PageDoc>) || model<PageDoc>('Page', PageSchema);
