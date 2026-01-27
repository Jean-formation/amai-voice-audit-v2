
export enum QuestionType {
  SELECT = 'select',
  MULTI_SELECT = 'array',
  STRING = 'string',
  BOOL = 'bool'
}

export interface Question {
  id: string;
  label: string;
  description?: string;
  type: QuestionType;
  notionKey: string;
  options?: string[];
  maxItems?: number;
  triggerAutre?: string;
  autreKey?: string;
}

export interface AuditData {
  [key: string]: any;
}

export interface Payload {
  body: AuditData;
  webhookUrl: string;
}
