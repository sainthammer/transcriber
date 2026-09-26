import type { Config, LlmProvider, Provider, ProviderInfo, SummaryTypeChoice } from '../api/types'

/** Conversations about people: suggest keeping them on the local model. */
export const PRIVATE_TYPES: SummaryTypeChoice[] = ['interview', 'one_on_one']

/**
 * Why a provider can't be used. Admins get the fix (it's in their settings),
 * everyone else learns whom to ask.
 */
export function providerReason(
  name: 'deepseek' | 'ollama',
  info: ProviderInfo,
  admin: boolean,
): string | null {
  if (info.available) return null
  switch (info.reason) {
    case 'no_api_key':
      return admin
        ? 'Нет ключа API — добавьте его в разделе «Модели и ключи»'
        : 'Нет ключа API — его добавляет администратор'
    case 'not_running':
      return admin
        ? 'Ollama не отвечает — проверьте, что она запущена и адрес в «Моделях и ключах» верный'
        : 'Локальная модель сейчас недоступна — сообщите администратору'
    case 'model_missing':
      return admin
        ? `Модель ${info.model} не скачана — выполните ollama pull ${info.model} или выберите другую`
        : 'Локальная модель не установлена — сообщите администратору'
    default:
      return name === 'deepseek' ? 'DeepSeek недоступен' : 'Локальная модель недоступна'
  }
}

/** The provider to preselect: the saved one if it's usable, else auto, else nothing works. */
export function usableProvider(config: Config, wanted: Provider | undefined): Provider | null {
  const { deepseek, ollama } = config.providers
  if (!deepseek.available && !ollama.available) return null
  if (wanted === 'deepseek' && deepseek.available) return 'deepseek'
  if (wanted === 'ollama' && ollama.available) return 'ollama'
  return 'auto'
}

/** A saved or previous type may have been switched off or deleted since — fall back to auto. */
export function usableType(config: Config | null, wanted: SummaryTypeChoice): SummaryTypeChoice {
  if (wanted === 'auto' || !config) return wanted
  return config.summary_types.some((t) => t.id === wanted) ? wanted : 'auto'
}

/** «встреча с клиентом, совещание или собеседование» */
export function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} или ${items[items.length - 1]}`
}

/** How a model that made a summary is named in the interface. */
export const providerName = (p: LlmProvider | 'unknown' | null | undefined) =>
  p === 'deepseek' ? 'DeepSeek' : p === 'ollama' ? 'Локальная модель' : null
