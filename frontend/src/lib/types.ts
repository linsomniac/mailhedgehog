// AIDEV-NOTE: Shared TypeScript types mirroring the mailhedgehog backend JSON shapes.
// Addr matches {Mailbox,Domain,Params,Relays} from the slim-Summary and FullMessage APIs.
// Summary is the slim shape returned from ?summary=1 endpoints and the WebSocket.
// FullMessage is the full shape from GET /api/v1/messages/<id>.

export interface Addr {
  Mailbox: string;
  Domain: string;
  Params: string;
  Relays: string[] | null;
}

export interface Summary {
  ID: string;
  From: Addr;
  To: Addr[];
  /** Full recipient count (To array is truncated to 3 in slim mode). */
  ToCount?: number;
  Subject: string;
  Created: string;
  Size: number;
}

export interface MIMEPart {
  Headers: { [key: string]: string[] };
  Body: string;
  Size: number;
  MIME: MIMEBody | null;
}

export interface MIMEBody {
  Parts: MIMEPart[];
}

export interface Content {
  Headers: { [key: string]: string[] };
  Body: string;
  Size: number;
  MIME: MIMEBody | null;
}

export interface FullMessage {
  ID: string;
  From: Addr;
  To: Addr[];
  Content: Content;
  MIME: MIMEBody | null;
  Created: string;
  Raw: {
    From: string;
    To: string[];
    Helo: string;
    Data: string;
  };
}

export interface Page<T> {
  total: number;
  count: number;
  start: number;
  items: T[];
}
