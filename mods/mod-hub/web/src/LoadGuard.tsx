// Catches a lazy part (the 3D views) that fails to load or throws, so one broken canvas never
// blanks the hub. A failed chunk load usually means the hub was updated while this tab was open.
import { Component, type ReactNode } from 'react'

import { Button } from './components/ui/button'

type Props = { children: ReactNode; what: string }

export class LoadGuard extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const isStale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message)
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="font-display text-lg">{isStale ? 'The hub was updated' : `The ${this.props.what} could not draw`}</p>
          <p className="text-sm text-muted-foreground">{isStale ? 'This tab is from before the update. Reload to get the new version.' : error.message}</p>
          <Button size="sm" variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}
