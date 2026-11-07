import { Image, ImageStyle, StyleProp } from 'react-native';

// Line icons (Lucide, rendered to PNG) tinted at runtime.
const SOURCES = {
  house: require('../../assets/icons/house.png'),
  landmark: require('../../assets/icons/landmark.png'),
  message: require('../../assets/icons/message-square.png'),
  folder: require('../../assets/icons/folder.png'),
  file: require('../../assets/icons/file-text.png'),
  fileCheck: require('../../assets/icons/file-check.png'),
  signature: require('../../assets/icons/signature.png'),
  clipboard: require('../../assets/icons/clipboard-list.png'),
  check: require('../../assets/icons/check.png'),
  circleCheck: require('../../assets/icons/circle-check.png'),
  upload: require('../../assets/icons/upload.png'),
  chevron: require('../../assets/icons/chevron-right.png'),
  calendar: require('../../assets/icons/calendar.png'),
  building: require('../../assets/icons/building-2.png'),
  settings: require('../../assets/icons/settings.png'),
  logout: require('../../assets/icons/log-out.png'),
  users: require('../../assets/icons/users.png'),
  user: require('../../assets/icons/user.png'),
  search: require('../../assets/icons/search.png'),
  phone: require('../../assets/icons/phone.png'),
  compose: require('../../assets/icons/square-pen.png'),
  send: require('../../assets/icons/send.png'),
  paperclip: require('../../assets/icons/paperclip.png'),
  more: require('../../assets/icons/ellipsis.png'),
  bell: require('../../assets/icons/bell.png'),
  back: require('../../assets/icons/chevron-left.png'),
  close: require('../../assets/icons/x.png'),
  clock: require('../../assets/icons/clock.png'),
  kanban: require('../../assets/icons/kanban.png'),
  listChecks: require('../../assets/icons/list-checks.png'),
  faceId: require('../../assets/icons/scan-face.png'),
  hash: require('../../assets/icons/hash.png'),
  plus: require('../../assets/icons/plus.png'),
  inbox: require('../../assets/icons/inbox.png'),
  mail: require('../../assets/icons/mail.png'),
  alert: require('../../assets/icons/circle-alert.png'),
} as const;

export type IconName = keyof typeof SOURCES;

export function Icon({ name, size = 22, color = '#99a4b4', style }: { name: IconName; size?: number; color?: string; style?: StyleProp<ImageStyle> }) {
  return <Image source={SOURCES[name]} style={[{ width: size, height: size, tintColor: color }, style]} resizeMode="contain" accessibilityElementsHidden importantForAccessibility="no" />;
}
