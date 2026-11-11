/**
 * Type declarations for Mailspring native extension points and exported stores
 */

declare module 'mailspring-exports' {
  export interface ComponentRegistryOptions {
    role: string;
    mode?: string;
    location?: string;
  }

  export const ComponentRegistry: {
    register: (component: any, options: ComponentRegistryOptions) => void;
    unregister: (component: any) => void;
  };

  export const ExtensionRegistry: {
    MessageView: {
      register: (extension: any) => void;
      unregister: (extension: any) => void;
    };
    Composer: {
      register: (extension: any) => void;
      unregister: (extension: any) => void;
    };
  };

  export const MessageStore: {
    find: (id: string) => Promise<any>;
    items: () => any[];
    subscribe: (callback: () => void) => () => void;
  };

  export const MessageBodyProcessor: {
    updateCacheForMessage: (message: any) => Promise<void>;
  };

  export const SanitizeTransformer: {
    run: (html: string) => Promise<string>;
  };

  export const DraftStore: {
    sessionForClientId: (id: string) => Promise<any>;
  };

  export const WorkspaceStore: {
    topSheet: () => any;
  };

  export const Actions: {
    recordUserEvent: (event: string, metadata?: Record<string, any>) => void;
  };
}
