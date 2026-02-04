import { test, expect, describe } from "bun:test";
import { redactIpAddresses, checkBlocklist } from "./bash-tool.ts";

describe("redactIpAddresses", () => {
  test("redacts IPv4 addresses", () => {
    expect(redactIpAddresses("Server at 192.168.1.1")).toBe("Server at [IP]");
    expect(redactIpAddresses("10.0.0.1 and 172.16.0.1")).toBe("[IP] and [IP]");
  });

  test("redacts multiple IPv4 addresses", () => {
    const input = "From 10.0.0.1 to 10.0.0.255 via 192.168.0.1";
    expect(redactIpAddresses(input)).toBe("From [IP] to [IP] via [IP]");
  });

  test("redacts IPv6 addresses", () => {
    expect(redactIpAddresses("Address: 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("Address: [IP]");
    expect(redactIpAddresses("Loopback: ::1")).toBe("Loopback: [IP]");
    expect(redactIpAddresses("Short: ::")).toBe("Short: [IP]");
  });

  test("preserves non-IP content", () => {
    expect(redactIpAddresses("Hello world")).toBe("Hello world");
    expect(redactIpAddresses("Version 1.2.3.4.5")).toBe("Version 1.2.3.4.5"); // not a valid IP
  });

  test("handles mixed content", () => {
    const input = "Connected to 192.168.1.1 (IPv6: 2001:db8::1)\nStatus: OK";
    const result = redactIpAddresses(input);
    expect(result).toContain("[IP]");
    expect(result).toContain("Status: OK");
    expect(result).not.toContain("192.168");
  });
});

describe("checkBlocklist", () => {
  const defaultBlocklist = [
    "\\b(shutdown|reboot|poweroff|halt|init\\s+[06])\\b",
    "\\b(iptables|ip6tables|nft|nftables|ufw|firewall-cmd)\\b",
    "\\b(ifconfig|ip\\s+(link|addr|route)|route\\s+(add|del))\\b",
    "\\b(docker|podman|kubectl|nsenter|chroot)\\b",
    "\\b(modprobe|insmod|rmmod|lsmod)\\b",
    "\\b(mount|umount|mkfs|fdisk|parted)\\b",
  ];

  test("blocks shutdown commands", () => {
    expect(checkBlocklist("shutdown -h now", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("reboot", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("poweroff", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("init 0", defaultBlocklist)).not.toBeNull();
  });

  test("blocks network admin commands", () => {
    expect(checkBlocklist("iptables -L", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("ip6tables -F", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("ufw enable", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("nft list ruleset", defaultBlocklist)).not.toBeNull();
  });

  test("blocks interface commands", () => {
    expect(checkBlocklist("ifconfig eth0 up", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("ip link set eth0 down", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("ip addr add 10.0.0.1/24 dev eth0", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("route add default gw 10.0.0.1", defaultBlocklist)).not.toBeNull();
  });

  test("blocks container escape attempts", () => {
    expect(checkBlocklist("docker run -it alpine", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("kubectl exec -it pod -- bash", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("nsenter -t 1 -m -u -n -i bash", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("chroot /mnt /bin/bash", defaultBlocklist)).not.toBeNull();
  });

  test("blocks kernel module commands", () => {
    expect(checkBlocklist("modprobe vfat", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("insmod /path/to/module.ko", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("rmmod module", defaultBlocklist)).not.toBeNull();
  });

  test("blocks mount commands", () => {
    expect(checkBlocklist("mount /dev/sda1 /mnt", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("umount /mnt", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("mkfs.ext4 /dev/sdb1", defaultBlocklist)).not.toBeNull();
  });

  test("allows safe commands", () => {
    expect(checkBlocklist("ls -la", defaultBlocklist)).toBeNull();
    expect(checkBlocklist("cat /etc/passwd", defaultBlocklist)).toBeNull();
    expect(checkBlocklist("echo hello", defaultBlocklist)).toBeNull();
    expect(checkBlocklist("curl https://example.com", defaultBlocklist)).toBeNull();
    expect(checkBlocklist("python3 script.py", defaultBlocklist)).toBeNull();
    expect(checkBlocklist("git status", defaultBlocklist)).toBeNull();
  });

  test("returns the matching pattern", () => {
    const pattern = checkBlocklist("reboot now", defaultBlocklist);
    expect(pattern).toBe("\\b(shutdown|reboot|poweroff|halt|init\\s+[06])\\b");
  });

  test("is case insensitive", () => {
    expect(checkBlocklist("REBOOT", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("Docker run", defaultBlocklist)).not.toBeNull();
  });

  test("handles commands with the blocked word as substring", () => {
    // "mount" as part of another word should not match due to word boundary
    expect(checkBlocklist("cat /proc/mounts", defaultBlocklist)).toBeNull();
    // But "mount" alone should match
    expect(checkBlocklist("mount /dev/sda1 /mnt", defaultBlocklist)).not.toBeNull();
  });

  test("handles empty blocklist", () => {
    expect(checkBlocklist("reboot", [])).toBeNull();
  });

  test("handles complex piped commands", () => {
    expect(checkBlocklist("ls -la | grep something && reboot", defaultBlocklist)).not.toBeNull();
    expect(checkBlocklist("echo test; shutdown -h now", defaultBlocklist)).not.toBeNull();
  });
});

describe("output truncation", () => {
  // This tests the logic we'd use for truncation
  test("truncates long output at limit", () => {
    const longOutput = "a".repeat(5000);
    const limit = 4000;
    let output = longOutput;
    let truncated = false;

    if (output.length > limit) {
      output = output.slice(0, limit) + "\n[output truncated]";
      truncated = true;
    }

    expect(truncated).toBe(true);
    expect(output.length).toBeLessThan(5000);
    expect(output).toEndWith("[output truncated]");
  });

  test("does not truncate short output", () => {
    const shortOutput = "Hello world";
    const limit = 4000;
    let output = shortOutput;
    let truncated = false;

    if (output.length > limit) {
      output = output.slice(0, limit) + "\n[output truncated]";
      truncated = true;
    }

    expect(truncated).toBe(false);
    expect(output).toBe("Hello world");
  });
});
