import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const MainAccountSchema = new Schema(
  {
    fbUserId: { type: String, required: true, unique: true },
    name: String,
    email: String,
    pictureUrl: String,
    // Long-lived user access token, AES-256-GCM encrypted. Never returned by default.
    accessTokenEnc: { type: String, required: true, select: false },
    tokenExpiresAt: Date,
    grantedScopes: [String],
    businesses: [{ _id: false, id: String, name: String }],
    // Business portfolio that owns client pages and sends page access requests
    businessId: String,
    isActive: { type: Boolean, default: true, index: true },
    lastPagesSyncAt: Date,
  },
  { timestamps: true },
);

export type MainAccountDoc = InferSchemaType<typeof MainAccountSchema>;
export const MainAccount: Model<MainAccountDoc> =
  (models.MainAccount as Model<MainAccountDoc>) || model<MainAccountDoc>('MainAccount', MainAccountSchema);
