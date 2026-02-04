import { Client } from '@stomp/stompjs'
import { AxiosError } from 'axios'
import dayjs from 'dayjs'
import { Search, ChevronLeft } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ZodError } from 'zod'

import {
  getChatRoomMessages,
  patchChatRoomMessageReadAll,
  postChatRoomImageUpload,
} from '@/apis/chat.api'
import ChatRoomMoreButton from '@/components/feature/projects/ChatRoomMoreButton'
import type { SubScribeChatRoomMessageRead } from '@/types/apis/chat/chat.api.types'
import type { ChatRoom, Message, MessageType } from '@/types/entities/chat-room/chatRoom.types'
import { getAccessToken, getAuthUser, type AuthUser } from '@/utils/authToken'

import GroupMessageItem from './component/ChatGroupMessageItem'
import ChatInputGroup from './component/ChatInputGroup'

export interface GroupMessage {
  senderId: number
  senderName: string
  isMine: boolean
  messages: Message[]
}

function groupMessagesByDate(messages: Message[]) {
  const groupedByDate: Record<string, Message[]> = {}

  messages.forEach((msg) => {
    const dateKey = dayjs(msg.createdAt).format('YYYY-MM-DD')
    if (!groupedByDate[dateKey]) {
      groupedByDate[dateKey] = []
    }
    groupedByDate[dateKey].push(msg)
  })

  return groupedByDate
}

function groupMessagesBySender(messages: Message[], myId: number) {
  const grouped: GroupMessage[] = []

  messages.forEach((msg) => {
    const lastGroup = grouped[grouped.length - 1]
    const isMine = msg.senderId === myId

    if (lastGroup && lastGroup.senderId === msg.senderId) {
      lastGroup.messages.push(msg)
    } else {
      grouped.push({
        senderId: msg.senderId,
        senderName: msg.senderName,
        isMine,
        messages: [msg],
      })
    }
  })

  return grouped
}

interface GroupMessageWithDate {
  date: string
  groups: GroupMessage[]
}
function getGroupedMessages(messages: Message[], myId: number) {
  const byDate = groupMessagesByDate(messages)
  const result: GroupMessageWithDate[] = []

  Object.entries(byDate).forEach(([date, msgs]) => {
    const groups = groupMessagesBySender(msgs, myId)
    result.push({ date, groups })
  })

  return result
}

const CHAT_API_URL = import.meta.env.VITE_API_CHAT_URL

interface ProjectChatRoomState {
  roomName: ChatRoom['roomName']
  projectId: string
}
const ProjectChatRoomPage = (): JSX.Element => {
  const navigate = useNavigate()
  const location = useLocation() as { state?: ProjectChatRoomState }
  const { roomId } = useParams<{ projectId: string; roomId: string }>()
  const roomName = location.state?.roomName
  const projectId = location.state?.projectId

  const [messages, setMessages] = useState<Message[]>([])
  const [groupedMessages, SetGroupedMessages] = useState<GroupMessageWithDate[]>()

  // 메세지 전송, 초기 렌더링 이벤트 발생시 하단으로 스크롤
  const mainRef = useRef<HTMLDivElement>(null)

  // 최초 렌더링 여부 파악
  const initialReadAllRef = useRef<boolean>(null)

  // 데이터 페칭
  useEffect(() => {
    const getChatMessages = async () => {
      try {
        const response = await getChatRoomMessages(
          { roomId: Number(roomId) },
          { page: 0, size: 20 },
        )
        setMessages(response.data.messages)
        initialReadAllRef.current = false
      } catch (error) {
        if (error instanceof ZodError) console.error('타입에러', error)
        else if (error instanceof AxiosError) console.error('네트워크에러', error)
      }
    }
    void getChatMessages()
  }, [roomId])

  // 메세지 그룹핑 및 모두 읽음 처리

  useEffect(() => {
    const user = getAuthUser()
    if (!user || messages.length === 0) {
      initialReadAllRef.current = true
      return
    }
    const groupedByDate = getGroupedMessages(messages, Number(user.id))
    SetGroupedMessages(groupedByDate)

    // 최초 렌더링시 모두 읽음 처리
    if (initialReadAllRef.current === false) {
      const lastMessageId = messages[messages.length - 1].id

      const readAll = async () => {
        try {
          await patchChatRoomMessageReadAll(
            { roomId: Number(roomId) },
            { messageId: lastMessageId },
          )
        } catch (error) {
          console.error(error)
        }
      }
      void readAll()
      initialReadAllRef.current = true
      setTimeout(() => {
        mainRef.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: 'smooth' })
      }, 100)
    }
  }, [messages, initialReadAllRef, roomId])

  // websocket
  const client = useRef<Client>(null)
  useEffect(() => {
    if (!client.current) {
      const token = getAccessToken()
      client.current = new Client({
        brokerURL: `${CHAT_API_URL.replace(/^http/, 'ws')}/chats/ws-chat`,
        connectHeaders: {
          Authorization: `Bearer ${token}`,
        },
        debug: (str) => console.log(str),
        reconnectDelay: 0,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
        onConnect: () => {
          console.log('connect')

          client.current?.subscribe(`/topic/chats/rooms/${roomId}`, (message) => {
            const payload = JSON.parse(message.body) as Message
            console.log(payload)
            setMessages((prev) => {
              const updated = [...prev, payload]
              //console.log(updated) // 여기서 찍으면 최신 상태 확인 가능
              return updated
            })
            setTimeout(() => {
              mainRef.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: 'smooth' })
            }, 100)

            const readPayload = { messageId: payload.id }
            client.current?.publish({
              destination: `/app/chats/rooms/${roomId}/read`,
              body: JSON.stringify(readPayload),
            })
            console.log(readPayload)
          })

          client.current?.subscribe(`/topic/chats/rooms/${roomId}/system`, (message) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const payload = JSON.parse(message.body)
            console.log(payload)
          })

          client.current?.subscribe(`/topic/chats/rooms/${roomId}/read`, (message) => {
            const payload = JSON.parse(message.body) as SubScribeChatRoomMessageRead['Response']
            console.log(payload.type)
            setMessages((prevMessages) => {
              if (!prevMessages) return prevMessages

              const updated = prevMessages.map((m) => {
                // 전체 읽음 처리
                if (
                  payload.type === 'MESSAGE_READ_ALL' &&
                  payload.newLastReadMessageId >= m.id &&
                  m.id > payload.oldLastReadMessageId
                ) {
                  console.log('Detected')
                  return { ...m, readCount: m.readCount + 1 }
                }

                // 개별 메시지 읽음 처리
                if (payload.type === 'MESSAGE_READ' && payload.messageId === m.id) {
                  return { ...m, readCount: m.readCount + 1 }
                }

                return m
              })

              return updated
            })
          })
        },
        onWebSocketClose: (close) => console.log('WebSocket closed', close),
        onWebSocketError: (err) => console.error('WebSocket error', err),
        onStompError: (frame) => console.error('STOMP error', frame),
      })
      client.current.activate()
    }

    return () => {
      void client.current?.deactivate()
    }
  }, [])

  const sendMessage = (content: string) => {
    if (!content) return
    if (!client.current?.connected) {
      console.warn('STOMP not connected')
      return
    }

    const payload = {
      roomId: Number(roomId),
      content,
      type: 'TEXT',
    }

    client.current.publish({
      destination: `/app/chats/rooms/${roomId}`,
      body: JSON.stringify(payload),
    })
    setTimeout(() => {
      mainRef.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: 'smooth' })
    }, 100)
  }

  const sendFile = async (file: File | undefined) => {
    if (!file) return
    if (!client.current?.connected) {
      console.warn('STOMP not connected')
      return
    }
    try {
      const formData: FormData = new FormData()
      formData.append('file', file)
      const messageType: MessageType = file.type.startsWith('image/') ? 'IMAGE' : 'FILE'
      const response = await postChatRoomImageUpload({ type: messageType }, formData)
      const url = response.data.url
      const payload = {
        roomId: Number(roomId),
        content: url,
        type: messageType,
      }
      client.current.publish({
        destination: `/app/chats/rooms/${roomId}`,
        body: JSON.stringify(payload),
      })
    } catch (error) {
      if (error instanceof ZodError) console.log('타입 에러', error)
      else if (error instanceof AxiosError) console.log('네트워크 에러', error)
      else console.log('기타 에러', error)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="fixed top-0 z-1 flex w-full justify-between bg-neutral-200 px-16 py-6">
        <span className="flex items-center gap-6 text-xl leading-8 font-semibold text-black">
          <button type="button" className="cursor-pointer" onClick={() => void navigate(-1)}>
            <ChevronLeft className="h-7 w-7 text-stone-700" />
          </button>
          {roomName}
        </span>

        <span className="flex items-center gap-5">
          {/* <button type="button" className="cursor-pointer">
            <Search className="h-8 w-8 text-stone-700" />
          </button> */}
          <ChatRoomMoreButton projectId={projectId} />
        </span>
      </header>

      <main ref={mainRef} className="flex flex-1 flex-col overflow-y-scroll px-14 pt-32 pb-32">
        {groupedMessages &&
          groupedMessages.map((dateGroup) => (
            <Fragment key={dateGroup.date}>
              {/* 날짜 헤더 */}
              <div className="mb-6 flex justify-center text-center text-base font-medium text-gray-500">
                {dayjs(dateGroup.date).format('YYYY년 M월 D일')}
              </div>

              {/* 발화자별 메시지 스택 */}
              {dateGroup.groups.map((group, i) => (
                <GroupMessageItem key={`${group.senderId}-${i}`} item={group} />
              ))}
            </Fragment>
          ))}
      </main>

      <form className="fixed bottom-0 z-1 w-full bg-white">
        <ChatInputGroup
          onSend={sendMessage}
          onFileSend={(file: File | undefined) => void sendFile(file)}
        />
      </form>
    </div>
  )
}

export default ProjectChatRoomPage
