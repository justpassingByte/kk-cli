import * as p from '@clack/prompts';
import { AkError, EXIT_CODES } from '../domain/contracts/ak-error.js';

export interface PromptService {
  chooseAuthMethod(): Promise<'email_otp' | 'api_key'>;
  email(initial?: string): Promise<string>;
  otp(): Promise<string>;
  apiKey(): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
}

export class ClackPromptService implements PromptService {
  async chooseAuthMethod(): Promise<'email_otp' | 'api_key'> {
    return requireAnswer(
      await p.select({
        message: 'How would you like to log in?',
        options: [
          { value: 'email_otp', label: 'Email code', hint: 'Recommended' },
          { value: 'api_key', label: 'API key' },
        ],
      }),
    );
  }

  async email(initial?: string): Promise<string> {
    return requireAnswer(
      await p.text({
        message: 'Email address',
        ...(initial ? { initialValue: initial } : {}),
        validate: (value) =>
          value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
            ? undefined
            : 'Enter a valid email.',
      }),
    );
  }

  async otp(): Promise<string> {
    return requireAnswer(
      await p.text({
        message: 'Six-digit code',
        validate: (value) =>
          value && /^\d{6}$/.test(value.trim()) ? undefined : 'Enter the six-digit code.',
      }),
    );
  }

  async apiKey(): Promise<string> {
    return requireAnswer(
      await p.password({
        message: 'AgentKit API key',
        validate: (value) => (value?.trim() ? undefined : 'API key is required.'),
      }),
    );
  }

  async confirm(message: string, initialValue = true): Promise<boolean> {
    return requireAnswer(
      await p.confirm({
        message,
        initialValue,
      }),
    );
  }
}

function requireAnswer<T>(answer: T | symbol): T {
  if (p.isCancel(answer)) {
    p.cancel('Nothing changed.');
    throw new AkError('Cancelled.', {
      code: 'cancelled',
      exitCode: EXIT_CODES.cancelled,
    });
  }
  return answer as T;
}
