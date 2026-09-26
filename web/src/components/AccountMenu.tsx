import { useState } from 'react'
import { ArrowLeft, KeyRound, LogOut, SlidersHorizontal } from 'lucide-react'
import { navigate } from '../lib/router'
import { useAuth } from '../state/authContext'
import { Avatar } from './ui/Avatar'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './ui/Menu'
import { ChangePasswordDialog } from './ChangePasswordDialog'
import styles from './AccountMenu.module.css'

interface Props {
  /** Inside the admin the menu leads back to the recordings instead. */
  place?: 'app' | 'admin'
}

export function AccountMenu({ place = 'app' }: Props) {
  const { user, isAdmin, logout } = useAuth()
  const [password, setPassword] = useState(false)

  return (
    <>
      <Menu
        trigger={
          <button type="button" className={styles.trigger} aria-label={`Учётная запись: ${user.name || user.email}`}>
            <Avatar name={user.name} email={user.email} />
          </button>
        }
      >
        <MenuLabel>
          {user.name && <strong>{user.name}</strong>}
          <span>{user.email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem icon={<KeyRound size={16} strokeWidth={1.75} />} onSelect={() => setPassword(true)}>
          Сменить пароль
        </MenuItem>
        {isAdmin && place === 'app' && (
          <MenuItem
            icon={<SlidersHorizontal size={16} strokeWidth={1.75} />}
            onSelect={() => navigate('/admin')}
          >
            Администрирование
          </MenuItem>
        )}
        {place === 'admin' && (
          <MenuItem icon={<ArrowLeft size={16} strokeWidth={1.75} />} onSelect={() => navigate('/')}>
            К записям
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<LogOut size={16} strokeWidth={1.75} />} onSelect={() => void logout()}>
          Выйти
        </MenuItem>
      </Menu>
      <ChangePasswordDialog open={password} onOpenChange={setPassword} />
    </>
  )
}
