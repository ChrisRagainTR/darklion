export type PortalLoginResponse = {
  token: string;
  person?: unknown;
  firm?: unknown;
};

export type StaffLoginResponse = {
  token: string;
  mfaSetupRequired?: boolean;
  firm?: {
    id?: string | number;
    name?: string;
    email?: string;
    plan?: string;
  };
};

export type StaffMe = {
  id?: string | number;
  name?: string;
  email?: string;
  plan?: string;
  userId?: string | number;
  role?: string;
  userName?: string;
};

export type StaffThread = {
  id: string | number;
  subject?: string | null;
  status?: string;
  category?: string;
  lastMessageAt?: string | null;
  createdAt?: string | null;
  staffUserId?: string | number | null;
  staffName?: string | null;
  isParticipant?: boolean;
  isArchived?: boolean;
  archivedAt?: string | null;
  sharedByName?: string | null;
  forwardedByName?: string | null;
  forwardedNote?: string | null;
  forwardedAt?: string | null;
  person?: {
    id?: string | number;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    relationshipName?: string | null;
    avatar_url?: string | null;
  };
  lastPreview?: string;
  unreadCount?: number;
  pendingDraftCount?: number;
  hasTaskMessages?: boolean;
};

export type StaffMessageAttachment = {
  id?: string | number;
  documentId?: string | number;
  displayName?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type StaffMessage = {
  id?: string | number;
  senderType?: string;
  senderId?: string | number | null;
  senderName?: string;
  body?: string;
  isInternal?: boolean;
  isEmmaDraft?: boolean;
  messageType?: string;
  createdAt?: string;
  readAt?: string | null;
  attachments?: StaffMessageAttachment[];
};

export type StaffThreadDetail = StaffThread & {
  messages?: StaffMessage[];
  pendingDrafts?: Array<{
    id?: string | number;
    draftBody?: string;
    confidence?: number | null;
    agentNotes?: string | null;
    agentName?: string | null;
    createdAt?: string;
  }>;
};

export type TeamChatMember = {
  id?: string | number;
  name?: string;
  email?: string;
  role?: string;
  avatar_url?: string | null;
};

export type TeamChatConversation = {
  id: string | number;
  conversation_id?: string | number;
  current_staff_user_id?: string | number;
  conversation_type?: 'dm' | 'group' | string;
  title?: string;
  chat_type?: string;
  is_pinned?: boolean;
  is_archived?: boolean;
  is_hidden?: boolean;
  last_message_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  unread_count?: number;
  preview_text?: string;
  members?: TeamChatMember[];
};

export type TeamChatAttachment = {
  id?: string | number;
  file_name?: string;
  content_type?: string;
  byte_size?: number | null;
  sha256?: string;
  metadata?: Record<string, unknown>;
};

export type TeamChatMessage = {
  id?: string | number;
  message_id?: string | number;
  conversation_id?: string | number;
  client_nonce?: string;
  sender_staff_user_id?: string | number;
  sender_name?: string;
  message_kind?: string;
  text?: string;
  body?: string;
  attachments?: TeamChatAttachment[];
  created_at?: string;
  date?: string;
  direction?: 'inbound' | 'outbound' | string;
  out?: boolean;
  can_delete?: boolean;
  is_unread?: boolean;
};

export type PipelineInstance = {
  id: string | number;
  name?: string | null;
  template_id?: string | number;
  template_name?: string | null;
  entity_type?: string | null;
  tax_year?: string | number | null;
  status?: string | null;
  job_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
};

export type PipelineStage = {
  id: string | number;
  name?: string;
  position?: number;
  is_terminal?: boolean;
  hold_for_migration?: boolean;
};

export type PipelineJobUpdate = {
  id?: string | number;
  job_id?: string | number;
  body?: string;
  created_at?: string;
  author_name?: string;
};

export type PipelineJob = {
  id: string | number;
  instance_id?: string | number;
  entity_type?: string;
  entity_id?: string | number;
  entity_name?: string;
  company_name?: string | null;
  person_name?: string | null;
  relationship_name?: string | null;
  relationship_id?: string | number | null;
  current_stage_id?: string | number | null;
  assigned_to?: string | number | null;
  assigned_name?: string | null;
  assigned_full_name?: string | null;
  priority?: string | null;
  due_date?: string | null;
  notes?: string | null;
  job_status?: string | null;
  status?: string | null;
  crm_entity_type?: string | null;
  billing_method?: string | null;
  recent_updates?: PipelineJobUpdate[];
  created_at?: string | null;
  updated_at?: string | null;
};

export type PipelineInstanceDetail = PipelineInstance & {
  template?: {
    id?: string | number;
    name?: string;
    entity_type?: string;
  };
  stages?: PipelineStage[];
  jobs?: PipelineJob[];
};

export type MessageContact = {
  id: string;
  name?: string;
  email?: string;
  credentials?: string;
  avatar_url?: string;
  unreadCount?: number;
  lastPreview?: string;
  lastMessageAt?: string;
};

export type PortalMessageAttachment = {
  documentId?: string | number;
  displayName?: string;
};

export type PortalMessage = {
  id?: string | number;
  body?: string;
  sender_type?: string;
  sender_name?: string;
  created_at?: string;
  createdAt?: string;
  attachments?: PortalMessageAttachment[];
};

export type MessageThreadResponse = {
  messages?: PortalMessage[];
};

export type PortalDocument = {
  id: string | number;
  firm_id?: string | number;
  firmId?: string | number;
  owner_type?: string;
  ownerType?: string;
  owner_id?: string | number;
  ownerId?: string | number;
  doc_type?: string;
  docType?: string;
  display_name?: string;
  displayName?: string;
  mime_type?: string;
  mimeType?: string;
  size_bytes?: number | null;
  sizeBytes?: number | null;
  is_delivered?: boolean;
  isDelivered?: boolean;
  delivered_at?: string | null;
  deliveredAt?: string | null;
  viewed_at?: string | null;
  viewedAt?: string | null;
  year?: string | number | null;
  folder_section?: string | null;
  folderSection?: string | null;
  folder_category?: string | null;
  folderCategory?: string | null;
  document_folder_id?: string | number | null;
  documentFolderId?: string | number | null;
  folder_subcategory?: string | null;
  folderSubcategory?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  relationship_id?: string | number | null;
  relationship_name?: string | null;
  person_id?: string | number | null;
  person_name?: string | null;
  company_id?: string | number | null;
  company_name?: string | null;
  uploaded_by_type?: string | null;
  uploadedByType?: string | null;
};

export type StaffContact = {
  id: string | number;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  filing_status?: string | null;
  portal_enabled?: boolean;
  spouse_name?: string | null;
  spouse_email?: string | null;
  spouse_portal_enabled?: boolean;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
  relationship_id?: string | number | null;
  relationship_name?: string | null;
  relationship_notes?: string | null;
  service_tier?: string | null;
  billing_status?: string | null;
  company_count?: string | number;
  avatar_url?: string | null;
};

export type StaffContactCompany = {
  id: string | number;
  company_name?: string | null;
  entity_type?: string | null;
  status?: string | null;
  billing_method?: string | null;
  bookkeeping_service?: string | null;
  access_level?: string | null;
  ownership_pct?: string | number | null;
};

export type StaffContactWorkflow = {
  id: string | number;
  entity_type?: string | null;
  entity_id?: string | number | null;
  entity_name?: string | null;
  pipeline_name?: string | null;
  stage_name?: string | null;
  stage_position?: string | number | null;
  tax_year?: string | number | null;
  priority?: string | null;
  due_date?: string | null;
  job_status?: string | null;
};

export type StaffDocumentSearchItem = {
  id: string | number;
  type: 'relationship' | 'person' | 'company' | string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  relationship_id?: string | number | null;
  relationship_name?: string | null;
  entity_type?: string | null;
  status?: string | null;
};

export type TaxDeliveryListItem = {
  id: string | number;
  title?: string;
  tax_year?: string | number;
  taxYear?: string | number;
  status?: string;
  intro_note?: string;
  tax_summary?: Record<string, unknown>;
  company_name?: string;
  approved_at?: string | null;
  approvedAt?: string | null;
  signed_at?: string | null;
  signedAt?: string | null;
  needs_changes_at?: string | null;
  needsChangesAt?: string | null;
  needs_changes_note?: string | null;
  updated_at?: string;
  updatedAt?: string;
};

export type TaxDeliveryDocument = {
  id?: string | number;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  apiUrl?: string | null;
  signedUrl?: string | null;
};

export type TaxSigner = {
  id?: string | number;
  signerRole?: string;
  name?: string;
  email?: string | null;
  approvedAt?: string | null;
  signedAt?: string | null;
  needsChangesAt?: string | null;
  needsChangesNote?: string | null;
};

export type TaxStage =
  | 'idle' | 'organizer_ready' | 'organizer_in_progress' | 'more_documents' | 'preparing'
  | 'review' | 'sign' | 'with_other_signers' | 'signed_waiting' | 'changes_requested'
  | 'signed' | 'filed' | 'accepted';

export type TrackerStep = { label: string; state: 'done' | 'current' | 'upcoming' };

export type ClientReturn = {
  id: number;
  kind: 'personal' | 'business';
  companyName: string | null;
  taxYear: string;
  title: string;
  stage: TaxStage;
  sentAt: string | null;
  dueText: string | null;
  figures: Array<{ label: string; amount: number; isRefund: boolean }>;
  filedAt: string | null;
  filedDateKnown?: boolean;
  acceptedAt: string | null;
  signedDocId: number | null;
  changeRequest: { note: string; by: string | null; at: string | null } | null;
  me: { role: string; approvedAt: string | null; signedAt: string | null } | null;
  signers: Array<{ name: string; role: string; isMe: boolean; approvedAt: string | null; signedAt: string | null }>;
};

export type ClientTaxStatus = {
  taxYear: string;
  today: string;
  firstName: string;
  stage: TaxStage;
  tracker: TrackerStep[] | null;
  organizer: {
    id: number;
    taxYear: string;
    status: string;
    submittedAt: string | null;
    reopenNote: string;
    progress: { total: number; resolved: number };
    requestedItems: Array<{ id: number; name: string; section: string }>;
  } | null;
  personalReturn: ClientReturn | null;
  businessReturns: ClientReturn[];
  businesses: Array<{ id: number; name: string }>;
  pastReturns: ClientReturn[];
  lastFiledReturn: { taxYear: string; stage: TaxStage; filedAt: string | null; filedDateKnown?: boolean; acceptedAt: string | null } | null;
  estimatedPayments: Array<{ jurisdiction: string; quarter: string; dueDate: string; dueText: string; amount: string }>;
  actions: Array<{ type: 'tax_return' | 'organizer' | 'organizer_requests'; deliveryId?: number; stage: TaxStage; count?: number }>;
};

export type FirmTeamMember = {
  id: number;
  name: string;
  credentials?: string;
  role?: string;
  avatar_url?: string | null;
};


export type TaxDeliveryPacket = {
  delivery: {
    id: string | number;
    firmName?: string;
    companyName?: string | null;
    taxYear?: string | number;
    title?: string;
    introNote?: string | null;
    taxSummary?: Record<string, unknown>;
    taxReportStatus?: string;
    taxReportData?: Record<string, unknown> | null;
    status?: string;
    needsChangesNote?: string | null;
    updatedAt?: string;
    createdAt?: string;
    companyId?: number | null;
    filedAt?: string | null;
    filedDateKnown?: boolean;
    acceptedAt?: string | null;
    signedDocId?: number | null;
    preparer?: { name: string; credentials?: string; avatarUrl?: string | null } | null;
  };
  currentSigner?: TaxSigner | null;
  signers?: TaxSigner[];
  allowedActions?: {
    canViewReviewDocument?: boolean;
    canViewSignatureDocument?: boolean;
    canApprove?: boolean;
    canRequestChanges?: boolean;
    canSign?: boolean;
  };
  documents?: {
    review?: TaxDeliveryDocument | null;
    signature?: TaxDeliveryDocument | null;
  };
  actionEndpoints?: {
    approve?: string;
    requestChanges?: string;
    sign?: string;
  };
  consentLanguage?: string;
};

export type MobileDashboard = {
  profile?: {
    firstName?: string;
    lastName?: string;
    name?: string;
  };
  counts?: {
    unreadMessages?: number;
    unviewedDocuments?: number;
    taxDeliveriesRequiringAction?: number;
  };
  tasks?: {
    taxDeliveries?: Array<{
      id: number | string;
      title?: string;
      taxYear?: number | string;
      tax_year?: number | string;
      updatedAt?: string;
      updated_at?: string;
      approvedAt?: string | null;
      approved_at?: string | null;
      signedAt?: string | null;
      signed_at?: string | null;
    }>;
  };
};
