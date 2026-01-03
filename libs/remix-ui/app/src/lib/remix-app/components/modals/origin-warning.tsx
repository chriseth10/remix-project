import React, { useEffect, useState } from 'react'
import { ModalDialog } from '@remix-ui/modal-dialog'
import { useDialogDispatchers } from '../../context/provider'

const OriginWarning = () => {
  const { alert } = useDialogDispatchers()
  const [content, setContent] = useState<string>(null)

  useEffect(() => {
  // origin warning disabled for this custom build
}, [])

  useEffect(() => {
    if (content) {
      alert({ id: 'warningOriging', title: null, message: content })
    }
  }, [content])

  return <></>
}

export default OriginWarning
