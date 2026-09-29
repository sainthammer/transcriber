import type { Config, LlmProvider, Provider, ProviderInfo, SummaryTypeChoice } from '../api/types'

/** Conversations about people: suggest keeping them on the local model. */
export const PRIVATE_TYPES: SummaryTypeChoice[] = ['interview', 'one_on_one']

/** Providers that send the transcript to someone else's servers and bill per token. */
export const CLOUD_PROVIDERS: readonly LlmProvider[] = ['deepseek', 'yandex']
export const isCloud = (p: string | null | undefined) => CLOUD_PROVIDERS.includes(p as LlmProvider)

/**
 * YandexGPT is optional: without a key it's switched off rather than «broken», so it's
 * offered only once someone has started setting it up (a key without a folder id counts).
 */
export const offersYandex = (config: Config) =>
  config.providers.yandex.available || config.providers.yandex.reason !== 'no_api_key'

/**
 * Why a provider can't be used. Admins get the fix (it's in their settings),
 * everyone else learns whom to ask.
 */
export function providerReason(
  name: LlmProvider,
  info: ProviderInfo,
  admin: boolean,
): string | null {
  if (info.available) return null
  switch (info.reason) {
    case 'no_api_key':
      return admin
        ? 'Нет ключа API — добавьте его в разделе «Модели и ключи»'
        : 'Нет ключа API — его добавляет администратор'
    case 'no_folder_id':
      return admin
        ? 'Нет ID каталога Yandex Cloud — добавьте его в разделе «Модели и ключи»'
        : 'YandexGPT не настроен — его настраивает администратор'
    case 'not_running':
      return admin
        ? 'Ollama не отвечает — проверьте, что она запущена и адрес в «Моделях и ключах» верный'
        : 'Локальная модель сейчас недоступна — сообщите администратору'
    case 'model_missing':
      return admin
        ? `Модель ${info.model} не скачана — выполните ollama pull ${info.model} или выберите другую`
        : 'Локальная модель не установлена — сообщите администратору'
    default:
      return name === 'ollama' ? 'Локальная модель недоступна' : `${providerName(name)} недоступен`
  }
}

/**
 * The provider to preselect: the saved one if it's usable, else auto, else YandexGPT
 * (auto never picks it, so it's the only way left), else nothing works.
 */
export function usableProvider(config: Config, wanted: Provider | undefined): Provider | null {
  const { deepseek, ollama, yandex } = config.providers
  // `wanted` comes from localStorage too: an unknown value simply falls through.
  if (wanted && wanted !== 'auto' && config.providers[wanted]?.available) return wanted
  if (deepseek.available || ollama.available) return 'auto'
  if (yandex.available) return 'yandex'
  return null
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
  p === 'deepseek' ? 'DeepSeek' : p === 'yandex' ? 'YandexGPT' : p === 'ollama' ? 'Локальная модель' : null
