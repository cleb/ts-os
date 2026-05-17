bits 16
org 0x100

    mov dx, message
    mov ah, 0x09
    int 0x21

    mov dl, '>'
    mov ah, 0x02
    int 0x21

    mov ah, 0x08
    int 0x21

    mov dx, done
    mov ah, 0x09
    int 0x21

    mov ax, 0x4c00
    int 0x21

message db 'Hello from an MS-DOS-style COM program running on TS-DOS!', 13, 10
        db 'INT 21h AH=09h prints this string; AH=02h prints one char.', 13, 10
        db 'Press any key at the > prompt.$'
done db 13, 10, 'Returned from INT 21h keyboard read.$'
