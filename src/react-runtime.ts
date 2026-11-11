type ReactRuntime = typeof import('react');

function isMissingMailspringExports(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes("Cannot find module 'mailspring-exports'")
  );
}

function resolveReact(): ReactRuntime {
  try {
    const mailspringExports = require('mailspring-exports') as { React?: ReactRuntime };
    if (mailspringExports.React) {
      return mailspringExports.React;
    }
  } catch (error) {
    if (!isMissingMailspringExports(error)) {
      throw error;
    }
  }

  return require('react') as ReactRuntime;
}

const React = resolveReact();

export const useState = React.useState;
export const useEffect = React.useEffect;
export default React;
