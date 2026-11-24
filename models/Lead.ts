import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

// Same workflow as the Lead Management app (C:\Aairavx\Lead_managment).
export const LEAD_STATUSES = ['NEW', 'WORKING', 'UNQUALIFIED', 'QUALIFIED', 'CLOSE', 'INVALID'] as const;
export const FOLLOW_UP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'VISIT'] as const;

const LeadSchema = new Schema(
  {
    leadgenId: { type: String, required: true, unique: true },
    pageId: { type: String, index: true },
    pageName: String,
    formId: { type: String, index: true },
    formName: String,
    adId: String,
    adName: String,
    adsetId: String,
    adsetName: String,
    campaignId: String,
    campaignName: String,
    platform: String, // fb | ig when Meta returns it
    isOrganic: Boolean,
    fullName: String,
    email: { type: String, index: true },
    phone: { type: String, index: true },
    fieldData: [{ _id: false, name: String, values: [String] }],
    fields: { type: Schema.Types.Mixed, default: {} },
    consents: [{ _id: false, checkbox_key: String, is_checked: String }],
    createdTime: { type: Date, index: true },
    // Lead management workflow (set by staff; Meta sync never overwrites these)
    status: { type: String, enum: LEAD_STATUSES, default: 'NEW', index: true },
    statusHistory: [{ _id: false, status: String, at: Date }],
    followUp: {
      at: Date,
      type: { type: String, enum: FOLLOW_UP_TYPES },
      notes: String,
    },
    source: { type: String, enum: ['webhook', 'sync'], default: 'sync' },
    fetchStatus: { type: String, enum: ['pending', 'fetched', 'failed'], default: 'fetched', index: true },
    fetchError: String,
    fetchAttempts: { type: Number, default: 0 },
    raw: Schema.Types.Mixed,
  },
  { timestamps: true },
);

export type LeadDoc = InferSchemaType<typeof LeadSchema>;
export const Lead: Model<LeadDoc> = (models.Lead as Model<LeadDoc>) || model<LeadDoc>('Lead', LeadSchema);
