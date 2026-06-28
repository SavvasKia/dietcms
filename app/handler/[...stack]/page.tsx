import { StackHandler } from '@stackframe/stack'
import { stackServerApp } from '@/stack'

export default function Handler(props: unknown) {
  // app and routeProps are deprecated in v2.8 but still accepted; fullPage is required
  return <StackHandler fullPage app={stackServerApp} routeProps={props} />
}
