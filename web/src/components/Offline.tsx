import styles from './Offline.module.css'

export function Offline() {
  return (
    <main className={styles.offline}>
      <h1 className={styles.title}>Нет связи с сервером</h1>
      <p className={styles.text}>Страница подключится сама, как только сервер снова станет доступен.</p>
    </main>
  )
}
