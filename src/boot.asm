bits 16
org 0x7c00

%define ROOT_BUFFER 0x0500
%define KERNEL_LOAD 0x1000
%define ROOT_LBA 19
%define ROOT_SECTORS 14
%define ROOT_ENTRIES 224
%define DATA_LBA_MINUS_TWO 31

    jmp short start
    nop

    db 'TSOS    '
    dw 512
    db 1
    dw 1
    db 2
    dw ROOT_ENTRIES
    dw 2880
    db 0xf0
    dw 9
    dw 18
    dw 2
    dd 0
    dd 0
    db 0
    db 0
    db 0x29
    dd 0x54534f53
    db 'TS OS      '
    db 'FAT12   '

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7c00
    sti
    mov [boot_drive], dl

    mov si, loading_msg
    call print

    mov ax, ROOT_LBA
    mov si, ROOT_SECTORS
    mov bx, ROOT_BUFFER
    call read_sectors

    mov di, ROOT_BUFFER
    mov dx, ROOT_ENTRIES
.find_entry:
    cmp byte [di], 0
    je kernel_missing
    cmp byte [di], 0xe5
    je .next_entry
    mov si, kernel_name
    mov cx, 11
    push di
    repe cmpsb
    pop di
    je .found_entry
.next_entry:
    add di, 32
    dec dx
    jnz .find_entry
    jmp kernel_missing

.found_entry:
    mov cx, [di + 28]
    add cx, 511
    shr cx, 9
    jz kernel_missing

    mov ax, [di + 26]
    cmp ax, 2
    jb kernel_missing
    add ax, DATA_LBA_MINUS_TWO
    mov si, cx
    mov bx, KERNEL_LOAD
    call read_sectors

    mov si, loaded_msg
    call print
    mov dl, [boot_drive]
    mov byte [0x04ff], dl
    jmp 0x0000:KERNEL_LOAD

read_sectors:
.next_sector:
    push ax
    push bx
    push si
    call read_one_sector
    pop si
    pop bx
    pop ax
    add bx, 512
    inc ax
    dec si
    jnz .next_sector
    ret

read_one_sector:
    push ax
    push bx
    push cx
    push dx
    push bx
    call lba_to_chs
    pop bx
    mov dl, [boot_drive]
    mov ah, 0x02
    mov al, 0x01
    int 0x13
    jc disk_error
    pop dx
    pop cx
    pop bx
    pop ax
    ret

lba_to_chs:
    xor dx, dx
    mov bx, 18
    div bx
    inc dl
    mov cl, dl
    xor dx, dx
    mov bx, 2
    div bx
    mov ch, al
    mov dh, dl
    ret

print:
    lodsb
    test al, al
    jz .done
    mov ah, 0x0e
    mov bx, 0x0007
    int 0x10
    jmp print
.done:
    ret

kernel_missing:
    mov si, missing_msg
    jmp fatal

disk_error:
    mov si, disk_msg

fatal:
    call print
    cli
.hang:
    hlt
    jmp .hang

kernel_name db 'DOSKRNL BIN'
loading_msg db 'TS-OS boot: reading FAT12...', 13, 10, 0
loaded_msg db 'Jumping to TypeScript DOS kernel.', 13, 10, 0
missing_msg db 'DOSKRNL.BIN not found.', 13, 10, 0
disk_msg db 'Disk read error.', 13, 10, 0
boot_drive db 0

times 510 - ($ - $$) db 0
dw 0xaa55
